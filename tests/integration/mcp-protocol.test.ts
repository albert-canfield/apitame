import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateOpenApiSkill } from '../../src/generator/skills.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { loadSkills } from '../../src/server/skills.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { petstore, petstoreConfig, tempDir } from '../helpers.js';

let mock: MockServer;
let rt: OpenApiRuntime;
const tmp = tempDir();

beforeAll(async () => {
  const spec = await petstore();
  mock = await startMockServer(extractOperations(spec.doc));
  const config = await petstoreConfig({
    mode: 'read-write',
    writes: { allow: ['deletePet'], confirm: [] },
  });
  rt = await createOpenApiRuntime({
    config,
    configDir: '.',
    spec,
    baseUrlOverride: mock.url,
    env: {},
  });
  for (const f of generateOpenApiSkill(rt)) {
    mkdirSync(join(tmp.dir, f.path, '..'), { recursive: true });
    writeFileSync(join(tmp.dir, f.path), f.content);
  }
});

afterAll(async () => {
  await mock.close();
  tmp.cleanup();
});

async function connect(elicitation?: 'accept' | 'decline') {
  const server = createMcpServer(rt, { skills: loadSkills(tmp.dir) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    elicitation ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (elicitation) {
    client.setRequestHandler('elicitation/create', async () =>
      elicitation === 'accept'
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' },
    );
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP protocol', () => {
  it('lists tools with JSON Schemas and annotations, and sends instructions', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('pet');
    const pet = tools.find((t) => t.name === 'pet')!;
    expect(pet.inputSchema.type).toBe('object');
    expect(pet.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toMatch(/Read-write mode/);
    await client.close();
  });

  it('calls a read tool', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'pet',
      arguments: { operation: 'getPetById', params: { petId: 1 } },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain('"status\\":200');
    await client.close();
  });

  it('asks the human through elicitation for destructive operations: decline', async () => {
    const { client } = await connect('decline');
    const before = mock.requests.filter((r) => r.operationId === 'deletePet').length;
    const res = await client.callTool({
      name: 'pet',
      arguments: { operation: 'deletePet', params: { petId: 9 } },
    });
    expect(res.isError).toBe(true);
    expect(mock.requests.filter((r) => r.operationId === 'deletePet').length).toBe(before);
    await client.close();
  });

  it('asks the human through elicitation for destructive operations: accept', async () => {
    const { client } = await connect('accept');
    const before = mock.requests.filter((r) => r.operationId === 'deletePet').length;
    const res = await client.callTool({
      name: 'pet',
      arguments: { operation: 'deletePet', params: { petId: 9 } },
    });
    expect(res.isError).toBeFalsy();
    expect(mock.requests.filter((r) => r.operationId === 'deletePet').length).toBe(before + 1);
    await client.close();
  });

  it('falls back to a confirmation token when the client has no elicitation', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'pet',
      arguments: { operation: 'deletePet', params: { petId: 9 } },
    });
    expect(JSON.stringify(res.content)).toContain('CONFIRMATION REQUIRED');
    await client.close();
  });

  it('serves generated skills through the MCP Skills extension', async () => {
    const { client } = await connect();
    expect(client.getServerCapabilities()?.extensions).toHaveProperty([
      'io.modelcontextprotocol/skills',
    ]);
    const list = await client.request(
      { method: 'skills/list', params: {} } as never,
      z
        .object({
          skills: z.array(
            z.object({
              uri: z.string(),
              frontmatter: z.record(z.string(), z.unknown()),
              resources: z.array(
                z.object({ uri: z.string(), digest: z.string(), size: z.number() }),
              ),
            }),
          ),
        })
        .passthrough(),
    );
    expect(list.skills).toHaveLength(1);
    const skill = list.skills[0]!;
    expect(skill.uri).toBe('skill://petstore-api/SKILL.md');
    expect(skill.frontmatter.name).toBe('petstore-api');
    const files = skill.resources.map((r) => r.uri);
    expect(files).toContain('skill://petstore-api/references/operations.md');

    const read = await client.readResource({ uri: skill.uri });
    const text = (read.contents[0] as { text: string }).text;
    expect(Buffer.byteLength(text)).toBe(skill.resources.find((r) => r.uri === skill.uri)!.size);
    expect(text).toMatch(/^---\nname: petstore-api/);

    const got = await client.request(
      { method: 'skills/get', params: { uri: skill.uri } } as never,
      z.object({ skill: z.object({ uri: z.string() }) }).passthrough(),
    );
    expect(got.skill.uri).toBe(skill.uri);
    await expect(client.readResource({ uri: 'skill://nope/SKILL.md' })).rejects.toThrow();
    await client.close();
  });
});

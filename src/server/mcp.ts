import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  Server,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VERSION } from '../version.js';
import type { CallContext, ElicitOutcome, Runtime } from '../types.js';
import { identityOf } from './oauth.js';
import { findSkillFile, mimeTypeFor, skillListEntry, skillUri, type SkillEntry } from './skills.js';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

export interface McpServerOptions {
  /** Skills to serve through the MCP Skills extension (a getter follows live reloads). */
  skills?: SkillEntry[] | (() => SkillEntry[]);
  /** Advertise tools/list_changed (set when `serve --watch` can change the tools). */
  listChanged?: boolean;
}

const CACHE = { ttlMs: 300_000, cacheScope: 'public' as const };

/**
 * Wire a runtime into an MCP server. The low-level Server is used on purpose:
 * tool schemas are plain JSON Schema generated from the source, and what is
 * sent in tools/list is exactly what `apitame inspect` measures.
 */
/** How long a human has to answer an approval prompt. */
const ELICIT_TIMEOUT_MS = 5 * 60_000;

export function createMcpServer(
  source: Runtime | (() => Runtime),
  opts: McpServerOptions = {},
): Server {
  const current = typeof source === 'function' ? source : () => source;
  const currentSkills =
    typeof opts.skills === 'function' ? opts.skills : () => (opts.skills as SkillEntry[]) ?? [];
  const runtime = current();
  const listChanged = opts.listChanged ?? false;
  const server = new Server(
    { name: `apitame-${runtime.name}`, version: VERSION },
    {
      capabilities: {
        tools: { listChanged },
        ...(currentSkills().length > 0
          ? { resources: { listChanged }, extensions: { [SKILLS_EXTENSION]: {} } }
          : {}),
      },
      instructions: runtime.instructions(),
    },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: current().listTools() }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const auth = ctx.http?.authInfo;
    const callCtx: CallContext = {
      signal: ctx.mcpReq.signal,
      // Who the OAuth token speaks for, for the audit log. Client and subject stay separate.
      ...(auth ? { caller: identityOf(auth) } : {}),
      elicit: async (message: string): Promise<ElicitOutcome> => {
        if (!server.getClientCapabilities()?.elicitation) return 'unsupported';
        try {
          const res = await ctx.mcpReq.elicitInput(
            {
              mode: 'form',
              message,
              requestedSchema: {
                type: 'object',
                properties: {
                  approve: {
                    type: 'boolean',
                    title: 'Approve this action',
                    description: 'Check to let the agent run it once.',
                    default: false,
                  },
                },
                required: ['approve'],
              },
            },
            {
              // On the tool call's own response stream. Over HTTP the client's standalone
              // stream may not be open yet, and a request sent there would be dropped.
              relatedRequestId: ctx.mcpReq.id,
              timeout: ELICIT_TIMEOUT_MS,
            },
          );
          if (res.action === 'accept') return res.content?.approve === true ? 'accept' : 'decline';
          return res.action === 'decline' ? 'decline' : 'cancel';
        } catch (err) {
          // Only "this client or protocol version cannot elicit" falls back to the token flow.
          // A prompt that failed or timed out means the human did not approve: a token now
          // would let the agent confirm on its own.
          const cannotElicit =
            err instanceof SdkError &&
            (err.code === SdkErrorCode.CapabilityNotSupported ||
              err.code === SdkErrorCode.MethodNotSupportedByProtocolVersion);
          return cannotElicit ? 'unsupported' : 'cancel';
        }
      },
    };
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await current().callTool(request.params.name, args, callCtx);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });

  if (currentSkills().length > 0) {
    server.setRequestHandler('resources/list', async () => ({
      resources: currentSkills().flatMap((s) =>
        s.files.map((f) => ({
          uri: skillUri(s.name, f.path),
          name: f.path === 'SKILL.md' ? s.name : `${s.name}/${f.path}`,
          mimeType: mimeTypeFor(f.path),
          size: f.bytes.length,
        })),
      ),
    }));

    server.setRequestHandler('resources/read', async (request) => {
      const found = findSkillFile(currentSkills(), request.params.uri);
      if (!found)
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown resource: ${request.params.uri}`,
        );
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: mimeTypeFor(found.file.path),
            text: found.file.bytes.toString('utf8'),
          },
        ],
      };
    });

    server.setRequestHandler(
      'skills/list',
      { params: z.object({ cursor: z.string().optional() }).passthrough().optional() },
      async () => ({
        resultType: 'complete',
        skills: currentSkills().map(skillListEntry),
        ...CACHE,
      }),
    );

    server.setRequestHandler(
      'skills/get',
      { params: z.object({ uri: z.string() }).passthrough() },
      async (params) => {
        const found = findSkillFile(currentSkills(), params.uri);
        if (!found || found.file.path !== 'SKILL.md')
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${params.uri}`);
        return { resultType: 'complete', skill: skillListEntry(found.skill), ...CACHE };
      },
    );
  }

  return server;
}

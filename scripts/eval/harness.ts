import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Logger } from '../../src/log.js';
import { startMockServer, type RecordedRequest } from '../../src/mock/server.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { toToolName } from '../../src/sources/openapi/grouping.js';
import { toolListCost } from '../../src/tokens/estimate.js';
import type { ToolDefinition, ToolSummary } from '../../src/types.js';
import { VERSION } from '../../src/version.js';
import { failureReasons, grade, type Attempt, type Check, type ExecutedRequest } from './grade.js';
import { matchArg, requestArgs } from './match.js';
import { costOf, type Price } from './pricing.js';
import { surfaceConfig, type ApiContext, type ApiId } from './surfaces.js';
import type { Task } from './tasks.js';
import {
  addUsage,
  emptyUsage,
  FatalProviderError,
  type Message,
  type Provider,
  type SurfaceId,
  type ToolCall,
  type ToolOutcome,
  type ToolSpec,
  type Usage,
} from './types.js';

/**
 * The system prompt for every run. It is the same for every surface; the only
 * part that varies is the server's own instructions, as in a real MCP client.
 */
export function systemPrompt(apiName: string, instructions: string): string {
  return [
    `You are an assistant connected to the ${apiName} API through an MCP server. Use its tools to handle the user's request.`,
    'Base your answer on what the tools return. When you are done, reply with a short final answer that states the specific values the user asked for.',
    instructions ? `Instructions from the MCP server:\n${instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export type EndReason = 'answered' | 'max-turns' | 'max-tokens' | 'refusal' | 'error';

export interface RunMetrics {
  /** Model requests in the run. */
  turns: number;
  toolCalls: number;
  /** Tool calls whose result was an error (blocked, invalid arguments, HTTP error). */
  failedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Model and tool time, without time spent waiting to retry. */
  wallMs: number;
  /** Estimate from list prices, or null when the model has no known price. */
  costUsd: number | null;
}

export type TranscriptEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; stopReason: string; usage: Usage }
  | { role: 'tool'; results: Array<ToolOutcome & { operation?: string }> };

export interface RunRecord {
  api: ApiId;
  task: string;
  kind: Task['kind'];
  surface: SurfaceId;
  provider: string;
  model: string;
  run: number;
  success: boolean;
  failures: string[];
  checks: Check[];
  endReason: EndReason;
  error?: string;
  answer: string;
  metrics: RunMetrics;
  requests: ExecutedRequest[];
  transcript: TranscriptEntry[];
}

export interface SurfaceInfo {
  api: ApiId;
  surface: SurfaceId;
  instructions: string;
  tools: ToolSpec[];
  /** apitame's estimate of what the tool list and instructions cost in context. */
  estimatedTokens: number;
}

interface Connection {
  client: Client;
  runtime: OpenApiRuntime;
  close(): Promise<void>;
}

/** The runtime for one surface behind a real MCP server and client, linked in memory. */
async function connect(api: ApiContext, surface: SurfaceId, baseUrl: string): Promise<Connection> {
  const redactor = new Redactor();
  const runtime = await createOpenApiRuntime({
    config: surfaceConfig(api, surface),
    configDir: api.configDir,
    spec: api.spec,
    env: api.env,
    baseUrlOverride: baseUrl,
    redactor,
    logger: new Logger(redactor, 'silent'),
  });
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'apitame-eval', version: VERSION });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    runtime,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function toolSpecs(tools: Array<{ name: string; description?: string; inputSchema: unknown }>) {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

/** What the model sees on a surface: the tools/list result and the server instructions. */
export async function describeSurface(api: ApiContext, surface: SurfaceId): Promise<SurfaceInfo> {
  const conn = await connect(api, surface, 'http://127.0.0.1:9');
  try {
    const { tools } = await conn.client.listTools();
    const instructions = conn.client.getInstructions() ?? '';
    const specs = toolSpecs(tools);
    const cost = toolListCost(
      specs.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as ToolDefinition['inputSchema'],
      })),
      instructions,
    );
    return { api: api.id, surface, instructions, tools: specs, estimatedTokens: cost.total };
  } finally {
    await conn.close();
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** The operation a tool call targets, as far as it can be told from the call. */
function resolveOperation(
  api: ApiContext,
  summaries: Map<string, ToolSummary>,
  call: ToolCall,
): string | undefined {
  const tool = summaries.get(call.name);
  const byId = (id: string) =>
    api.operations.find((o) => o.id === id || o.id.toLowerCase() === id.toLowerCase())?.id ??
    (id || undefined);
  switch (tool?.kind) {
    case 'group':
      return typeof call.input.operation === 'string' ? byId(call.input.operation) : undefined;
    case 'operation':
      return tool.operations[0];
    case 'call':
      return typeof call.input.operationId === 'string' ? byId(call.input.operationId) : undefined;
    case 'search':
      return undefined;
    default:
      // An unknown tool: the agent may have guessed a one-tool-per-endpoint name.
      return api.operations.find((o) => toToolName(o.id) === call.name)?.id;
  }
}

function fixtureHandler(api: ApiContext, task: Task, sources: Map<RecordedRequest, string>) {
  const byId = new Map(api.operations.map((o) => [o.id, o]));
  return (req: RecordedRequest) => {
    if (!req.operationId) {
      sources.set(req, 'no-route');
      return undefined;
    }
    const fixtures = task.fixtures.filter((f) => f.operation === req.operationId);
    if (fixtures.length === 0) {
      sources.set(req, 'sample');
      return undefined;
    }
    const args = requestArgs(byId.get(req.operationId), req);
    const hit = fixtures.find((f) =>
      Object.entries(f.match).every(([k, v]) => matchArg(args[k], v)),
    );
    if (!hit) {
      // Fixtures define the data for this operation: anything else does not exist.
      sources.set(req, 'not-found');
      return { status: 404, body: { message: 'Not Found' } };
    }
    sources.set(req, 'fixture');
    return { status: hit.status, body: hit.body };
  };
}

export interface RunOptions {
  api: ApiContext;
  surface: SurfaceId;
  task: Task;
  provider: Provider;
  run: number;
  maxTurns: number;
  price?: Price;
}

/** Run one task once on one surface: the agent loop, then grading. */
export async function runOnce(opts: RunOptions): Promise<RunRecord> {
  const { api, surface, task, provider } = opts;
  const sources = new Map<RecordedRequest, string>();
  const mock = await startMockServer(api.operations, {
    handler: fixtureHandler(api, task, sources),
  });
  const conn = await connect(api, surface, mock.url);
  const summaries = new Map(conn.runtime.summarizeTools().map((s) => [s.name, s]));

  const transcript: TranscriptEntry[] = [{ role: 'user', text: task.prompt }];
  const messages: Message[] = [{ role: 'user', text: task.prompt }];
  const attempts: Attempt[] = [];
  let usage = emptyUsage();
  let turns = 0;
  let waitedMs = 0;
  let answer = '';
  let endReason: EndReason = 'max-turns';
  let error: string | undefined;
  const started = performance.now();

  try {
    const { tools } = await conn.client.listTools();
    const specs = toolSpecs(tools);
    const system = systemPrompt(api.config.name, conn.client.getInstructions() ?? '');
    const session = provider.session(task, surface);

    while (turns < opts.maxTurns) {
      turns++;
      const turn = await session.next({ system, tools: specs, messages });
      usage = addUsage(usage, turn.usage);
      waitedMs += turn.waitedMs ?? 0;
      messages.push({
        role: 'assistant',
        text: turn.text,
        toolCalls: turn.toolCalls,
        providerContent: turn.providerContent,
      });
      transcript.push({
        role: 'assistant',
        text: turn.text,
        toolCalls: turn.toolCalls,
        stopReason: turn.stopReason,
        usage: turn.usage,
      });

      if (turn.stopReason === 'max_tokens') {
        endReason = 'max-tokens';
        answer = turn.text;
        break;
      }
      if (turn.stopReason === 'refusal') {
        endReason = 'refusal';
        answer = turn.text;
        break;
      }
      if (turn.toolCalls.length === 0) {
        if (turn.stopReason === 'pause_turn') continue;
        endReason = 'answered';
        answer = turn.text;
        break;
      }

      const results: Array<ToolOutcome & { operation?: string }> = [];
      for (const call of turn.toolCalls) {
        const operation = resolveOperation(api, summaries, call);
        let outcome: ToolOutcome;
        try {
          const res = await conn.client.callTool({ name: call.name, arguments: call.input });
          outcome = {
            id: call.id,
            name: call.name,
            content: textOf(res.content),
            isError: res.isError === true,
          };
        } catch (err) {
          outcome = {
            id: call.id,
            name: call.name,
            content: (err as Error).message,
            isError: true,
          };
        }
        attempts.push({
          tool: call.name,
          isError: outcome.isError,
          ...(operation ? { operation } : {}),
        });
        results.push({ ...outcome, ...(operation ? { operation } : {}) });
      }
      messages.push({ role: 'tool', results });
      transcript.push({ role: 'tool', results });
    }
  } catch (err) {
    if (err instanceof FatalProviderError) {
      await conn.close();
      await mock.close();
      throw err;
    }
    endReason = 'error';
    error = (err as Error).message;
  }
  const wallMs = Math.max(0, performance.now() - started - waitedMs);
  await conn.close();
  await mock.close();

  const byId = new Map(api.operations.map((o) => [o.id, o]));
  const requests: ExecutedRequest[] = mock.requests.map((r) => ({
    ...(r.operationId ? { operationId: r.operationId } : {}),
    method: r.method,
    path: r.path,
    args: requestArgs(r.operationId ? byId.get(r.operationId) : undefined, r),
    response: (sources.get(r) ?? 'sample') as ExecutedRequest['response'],
  }));

  const result = grade({
    task,
    answer,
    finished: endReason === 'answered',
    endReason,
    attempts,
    executed: requests,
    writeOperations: api.writeOperations,
  });

  return {
    api: api.id,
    task: task.id,
    kind: task.kind,
    surface,
    provider: provider.name,
    model: provider.model,
    run: opts.run,
    success: result.success,
    failures: failureReasons(result),
    checks: result.checks,
    endReason,
    ...(error ? { error } : {}),
    answer,
    metrics: {
      turns,
      toolCalls: attempts.length,
      failedToolCalls: attempts.filter((a) => a.isError).length,
      ...usage,
      wallMs: Math.round(wallMs),
      costUsd: costOf(usage, opts.price),
    },
    requests,
    transcript,
  };
}

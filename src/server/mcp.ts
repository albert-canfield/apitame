import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  Server,
  type ElicitRequestFormParams,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VERSION } from '../version.js';
import type { ApprovalRound, CallContext, ElicitOutcome, Runtime } from '../types.js';
import { identityOf } from './oauth.js';
import { findSkillFile, mimeTypeFor, skillListEntry, skillUri, type SkillEntry } from './skills.js';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

export interface McpServerOptions {
  /** Skills to serve through the MCP Skills extension (a getter follows live reloads). */
  skills?: SkillEntry[] | (() => SkillEntry[]);
  /** Advertise tools/list_changed (set when `serve --watch` can change the tools). */
  listChanged?: boolean;
}

/** Servers that `serveHttp` serves without a token or OAuth. */
const withoutAuth = new WeakSet<Server>();

/**
 * Mark a server as served over HTTP without authentication: any local process that can reach the
 * port could answer an approval prompt itself, so under `confirmation.method: elicitation`
 * approvals are refused, in both protocol eras. `serveHttp` marks every server it serves that way.
 */
export function markServedWithoutAuth(server: Server): Server {
  withoutAuth.add(server);
  return server;
}

const CACHE = { ttlMs: 300_000, cacheScope: 'public' as const };

/** How long a human has to answer an approval prompt. */
const ELICIT_TIMEOUT_MS = 5 * 60_000;

/** The form shown to the human: one checkbox, unchecked by default. Same in both protocol eras. */
const APPROVE_FORM: ElicitRequestFormParams['requestedSchema'] = {
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
};

/** The first protocol revision where requests carry their own envelope (multi round-trip input). */
const MODERN_PROTOCOL = '2026-07-28';

/**
 * Whether this server instance serves a 2026-07-28 client. The SDK's serving entries mark an
 * instance modern before it handles anything; a 2025-era `initialize` binds it legacy, and a
 * stateless 2025-era instance never negotiates a version at all.
 */
function servesModernEra(server: Server): boolean {
  const version = server.getNegotiatedProtocolVersion();
  return version !== undefined && version >= MODERN_PROTOCOL;
}

/**
 * Whether a 2026-07-28 request may carry a form for the human. The same rule the SDK applies
 * before sending one: elicitation declared with form mode, or declared without any mode (which
 * means form).
 */
function canShowForm(capabilities: unknown): boolean {
  const elicitation = (capabilities as { elicitation?: unknown } | undefined)?.elicitation;
  if (elicitation === undefined || elicitation === null) return false;
  if (typeof elicitation !== 'object' || Array.isArray(elicitation)) return true;
  const modes = elicitation as { form?: unknown; url?: unknown };
  return modes.form !== undefined || modes.url === undefined;
}

/** Read the approval state of a 2026-07-28 request: what the client can do and what it sent back. */
function approvalRoundOf(ctx: ServerContext): ApprovalRound {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const state = ctx.mcpReq.requestState();
  const response = inputResponse(ctx.mcpReq.inputResponses, 'approve');
  const answer =
    response.kind !== 'elicit'
      ? undefined
      : response.action === 'accept'
        ? response.content?.approve === true
          ? 'accept'
          : 'decline'
        : response.action;
  return {
    canAsk: canShowForm(envelope?.[CLIENT_CAPABILITIES_META_KEY]),
    ...(typeof state === 'string' ? { state } : {}),
    ...(answer ? { answer } : {}),
  };
}

/**
 * Wire a runtime into an MCP server. The low-level Server is used on purpose:
 * tool schemas are plain JSON Schema generated from the source, and what is
 * sent in tools/list is exactly what `apitame inspect` measures.
 *
 * The same server serves both protocol eras. On a 2025-era connection the human is asked in
 * the middle of the call (`elicitation/create`). On protocol 2026-07-28, which has no requests
 * from server to client, the call returns the prompt as an input-required result and the client
 * calls again with the answer.
 */
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
      // Approvals on 2025-era connections use elicitInput() below. An input-required result must
      // never reach one: the SDK would ask the human through its own loop, outside the audit log.
      inputRequired: { legacyShim: false },
    },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: current().listTools() }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const auth = ctx.http?.authInfo;
    const modern = servesModernEra(server);
    const callCtx: CallContext = {
      signal: ctx.mcpReq.signal,
      // Who the OAuth token speaks for, for the audit log. Client and subject stay separate.
      ...(auth ? { caller: identityOf(auth) } : {}),
      ...(withoutAuth.has(server) ? { anyoneCanAnswer: true } : {}),
    };
    if (modern) {
      // Protocol 2026-07-28 has no requests from server to client: the prompt goes back to the
      // client as the result of this call (see `confirmOrChallenge`).
      callCtx.approval = approvalRoundOf(ctx);
    } else {
      callCtx.elicit = async (message: string): Promise<ElicitOutcome> => {
        if (!server.getClientCapabilities()?.elicitation) return 'unsupported';
        try {
          const res = await ctx.mcpReq.elicitInput(
            { mode: 'form', message, requestedSchema: APPROVE_FORM },
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
      };
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await current().callTool(request.params.name, args, callCtx);
    if (modern && result.inputRequired) {
      return inputRequired({
        inputRequests: {
          approve: inputRequired.elicit({
            mode: 'form',
            message: result.inputRequired.message,
            requestedSchema: APPROVE_FORM,
          }),
        },
        requestState: result.inputRequired.requestState,
      });
    }
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

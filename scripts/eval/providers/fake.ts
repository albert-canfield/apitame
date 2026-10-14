import { toToolName } from '../../../src/sources/openapi/grouping.js';
import { estimateTokens } from '../../../src/tokens/estimate.js';
import type { Task } from '../tasks.js';
import type { ModelRequest, ModelSession, ModelTurn, Provider, ToolSpec } from '../types.js';

interface PlannedCall {
  name: string;
  input: Record<string, unknown>;
}

/** The operation ids a grouped tool accepts, from its `operation` enum. */
function groupedOperations(tool: ToolSpec): unknown[] {
  const props = tool.inputSchema.properties as Record<string, { enum?: unknown[] }> | undefined;
  return props?.operation?.enum ?? [];
}

function searchWords(operationId: string): string {
  return operationId
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A scripted model for tests and CI. It replays the calls listed under `fake.steps`
 * in a task, one per turn, translated to whatever the surface offers: a grouped tool,
 * a single-operation tool, or search_operations followed by call_operation. Then it
 * gives the scripted answer. Token counts are apitame's estimates of what it was sent.
 */
export class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly estimatedUsage = true;

  constructor(readonly model = 'scripted') {}

  session(task: Task): ModelSession {
    return new FakeSession(task.fake);
  }
}

class FakeSession implements ModelSession {
  private plan: PlannedCall[] | undefined;
  private readonly unreachable: string[] = [];
  private turn = 0;

  constructor(private readonly script: Task['fake']) {}

  async next(req: ModelRequest): Promise<ModelTurn> {
    this.plan ??= this.expand(req.tools);
    const inputTokens = estimateTokens(
      JSON.stringify({ system: req.system, tools: req.tools, messages: req.messages }),
    );
    const call = this.plan.shift();
    if (call) {
      this.turn++;
      return {
        text: '',
        toolCalls: [{ id: `fake_${this.turn}`, name: call.name, input: call.input }],
        usage: {
          inputTokens,
          outputTokens: estimateTokens(JSON.stringify(call)),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: 'tool_use',
      };
    }
    const text =
      this.unreachable.length > 0
        ? `I could not find a tool for ${this.unreachable.join(', ')}.`
        : this.script.answer;
    return {
      text,
      toolCalls: [],
      usage: {
        inputTokens,
        outputTokens: estimateTokens(text),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      stopReason: 'end_turn',
    };
  }

  private expand(tools: ToolSpec[]): PlannedCall[] {
    const names = new Set(tools.map((t) => t.name));
    const plan: PlannedCall[] = [];
    for (const step of this.script.steps) {
      const group = tools.find((t) => groupedOperations(t).includes(step.operation));
      if (group) {
        plan.push({ name: group.name, input: { operation: step.operation, params: step.params } });
        continue;
      }
      const single = toToolName(step.operation);
      if (names.has(single)) {
        plan.push({ name: single, input: { ...step.params } });
        continue;
      }
      if (names.has('call_operation')) {
        if (names.has('search_operations')) {
          plan.push({ name: 'search_operations', input: { query: searchWords(step.operation) } });
        }
        plan.push({
          name: 'call_operation',
          input: { operationId: step.operation, params: step.params },
        });
        continue;
      }
      this.unreachable.push(step.operation);
    }
    return plan;
  }
}

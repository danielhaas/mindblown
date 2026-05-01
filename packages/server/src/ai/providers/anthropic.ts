/**
 * Anthropic chat provider — uses @anthropic-ai/sdk against the Claude API.
 *
 * Defaults to claude-opus-4-7. System prompt is marked with cache_control;
 * since render order is tools → system → messages, that single breakpoint
 * caches both the tool definitions and the system prompt across turns —
 * cuts cost ~80% on multi-turn conversations.
 *
 * Adaptive thinking is intentionally OFF for chat: each step is a discrete
 * action (one tool call or a short reply), so reasoning overhead doesn't
 * pay off and we sidestep the cross-step thinking-block continuity rules.
 * `effort: high` is the recommended floor for intelligence-sensitive work.
 */

import Anthropic from '@anthropic-ai/sdk';
import { specToAnthropicTool } from '@mindblown/tool-kit';
import type {
  ChatProvider,
  NormalizedMessage,
  ProviderEvent,
  RunTurnOptions,
} from './types.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';

export const anthropicAvailable = ANTHROPIC_API_KEY.length > 0;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    if (!anthropicAvailable) {
      throw new Error('Anthropic provider unavailable — set ANTHROPIC_API_KEY');
    }
    _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return _client;
}

function toAnthropicMessages(messages: NormalizedMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      // An assistant message must have at least one content block.
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content: blocks });
    } else {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      });
    }
  }
  return out;
}

export const anthropicProvider: ChatProvider = {
  name: 'anthropic',
  model: ANTHROPIC_MODEL,

  async *runTurn(opts: RunTurnOptions): AsyncIterable<ProviderEvent> {
    const client = getClient();

    // The SDK types `input_schema` as `{type: "object", ...}` with a literal
    // string. zodToJsonSchema emits the same shape at runtime, but its return
    // type is `Record<string, unknown>` — bridge with a structural cast.
    const tools = opts.tools.map(
      (s) => specToAnthropicTool(s) as unknown as Anthropic.Tool,
    );

    const stream = client.messages.stream({
      model: ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      // effort: 'high' is the floor for intelligence-sensitive work on Opus 4.7.
      // `output_config` may not be in every SDK version's strict types yet;
      // pass it through with a typed loosening rather than guess at the shape.
      ...({ output_config: { effort: 'high' } } as Record<string, unknown>),
      system: [
        {
          type: 'text',
          text: opts.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools,
      messages: toAnthropicMessages(opts.messages),
    });

    // Per-block accumulators for tool_use input JSON, keyed by content-block index.
    const toolBlocks = new Map<
      number,
      { id: string; name: string; jsonAccum: string }
    >();
    let stopReason: Anthropic.Message['stop_reason'] = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              jsonAccum: '',
            });
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const tb = toolBlocks.get(event.index);
            if (tb) tb.jsonAccum += event.delta.partial_json;
          }
          break;

        case 'content_block_stop': {
          const tb = toolBlocks.get(event.index);
          if (tb) {
            let args: Record<string, unknown> = {};
            if (tb.jsonAccum.trim().length > 0) {
              try {
                args = JSON.parse(tb.jsonAccum);
              } catch {
                args = {};
              }
            }
            yield {
              type: 'tool_call',
              toolCall: { id: tb.id, name: tb.name, args },
            };
          }
          break;
        }

        case 'message_delta':
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
          break;
      }
    }

    const reason: 'stop' | 'tool_use' | 'max_tokens' | 'other' =
      stopReason === 'tool_use'
        ? 'tool_use'
        : stopReason === 'end_turn'
          ? 'stop'
          : stopReason === 'max_tokens'
            ? 'max_tokens'
            : 'other';
    yield { type: 'turn_end', reason };
  },
};

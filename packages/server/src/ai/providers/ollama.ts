/**
 * Ollama / OpenAI-compatible chat provider.
 *
 * Wraps the existing OpenAI SDK pointed at AI_BASE_URL (qwen2.5:14b by
 * default). Non-streaming under the hood — yields the full assistant
 * content as a single text_delta to match the original chat behavior.
 */

import type OpenAI from 'openai';
import type { ToolSpec } from '@mindblown/tool-kit';
import { specToOpenAiTool } from '@mindblown/tool-kit';
import { getClient, JSON_OBJECT_FORMAT, withAiSlot } from '../client.js';
import type {
  ChatProvider,
  CompletionOptions,
  NormalizedMessage,
  ProviderEvent,
  RunTurnOptions,
} from './types.js';

const AI_MODEL = process.env.AI_MODEL ?? 'qwen2.5:14b';

/**
 * AI_REASONING_EFFORT (low/medium/high) — set only for a thinking model
 * (qwen3 on LM Studio). Its reasoning tokens count against max_tokens, so a
 * 2048 budget ended in `finish_reason: length` with empty content. Unset by
 * default: Ollama 400s the parameter on a non-thinking model.
 */
const AI_REASONING_EFFORT = process.env.AI_REASONING_EFFORT ?? '';
const REASONING_HEADROOM = 4096;

/**
 * AI_THINKING=off — switch a thinking model's reasoning phase off at the
 * chat template (`chat_template_kwargs.enable_thinking=false`, honoured by
 * vLLM and llama.cpp for Qwen3; LM Studio ignores it). Measured on the
 * 2×5080 vLLM with qwen3.6-27b: a JSON draft took 10 s and 1,200 reasoning
 * tokens with thinking, 0.6 s without, same answer. `reasoning_effort`
 * does not change that on vLLM. Opt-in: Ollama's /v1 may reject the
 * unknown field on older versions.
 */
const AI_THINKING_OFF = (process.env.AI_THINKING ?? '').trim().toLowerCase() === 'off';

function tokenParams(maxTokens: number) {
  const thinking = AI_THINKING_OFF ? { chat_template_kwargs: { enable_thinking: false } } : {};
  if (!AI_REASONING_EFFORT) return { max_tokens: maxTokens, ...thinking };
  return {
    max_tokens: maxTokens + REASONING_HEADROOM,
    reasoning_effort: AI_REASONING_EFFORT as OpenAI.ReasoningEffort,
    ...thinking,
  };
}

/** qwen2.5 occasionally outputs Thai/Chinese despite English instructions. Strip those lines. */
function stripNonEnglish(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/[฀-๿一-鿿぀-ヿ]/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toOpenAiMessages(
  systemPrompt: string,
  messages: NormalizedMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const tcs = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(tcs.length > 0 ? { tool_calls: tcs } : {}),
      } as OpenAI.ChatCompletionMessageParam);
    } else {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    }
  }
  return out;
}

export const ollamaProvider: ChatProvider = {
  name: 'ollama',
  model: AI_MODEL,

  async *runTurn(opts: RunTurnOptions): AsyncIterable<ProviderEvent> {
    const client = getClient();
    const tools = opts.tools.map(
      (s: ToolSpec) => specToOpenAiTool(s) as unknown as OpenAI.ChatCompletionTool,
    );

    // Share the chatCompletion/embed slot so chat-panel turns can't race
    // ai_estimate (or each other) onto Ollama's single inference slot —
    // that race was the source of the 502s the queue was supposed to fix.
    const response = await withAiSlot(() =>
      client.chat.completions.create(
        {
          model: AI_MODEL,
          messages: toOpenAiMessages(opts.systemPrompt, opts.messages),
          tools,
          temperature: 0.3,
          ...tokenParams(opts.maxTokens ?? 2048),
        },
        opts.signal ? { signal: opts.signal } : undefined,
      ),
    );

    const choice = response.choices[0];
    if (!choice) {
      yield { type: 'turn_end', reason: 'other' };
      return;
    }

    const msg = choice.message;
    if (msg.content) {
      const cleaned = stripNonEnglish(msg.content);
      if (cleaned) yield { type: 'text_delta', text: cleaned };
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Only the first tool call — multi-tool turns destabilize 14B models.
      const tc = msg.tool_calls[0];
      const fn = (tc as any).function as { name: string; arguments: string };
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        args = {};
      }
      yield { type: 'tool_call', toolCall: { id: tc.id, name: fn.name, args } };
      yield { type: 'turn_end', reason: 'tool_use' };
      return;
    }

    const reason = choice.finish_reason === 'length' ? 'max_tokens' : 'stop';
    yield { type: 'turn_end', reason };
  },

  async complete(opts: CompletionOptions): Promise<string> {
    const client = getClient();
    const json = (opts.format ?? 'json') === 'json';
    const response = await withAiSlot(() =>
      client.chat.completions.create(
        {
          model: opts.model ?? AI_MODEL,
          messages: [
            { role: 'system', content: opts.systemPrompt },
            // No prompt caching on this side — the parts simply concatenate.
            { role: 'user', content: opts.parts.map((p) => p.text).join('\n\n') },
          ],
          temperature: opts.temperature ?? (json ? 0 : 0.4),
          ...tokenParams(opts.maxTokens ?? 1024),
          // OpenAI-compatible JSON mode (see JSON_OBJECT_FORMAT). Callers
          // still validate — small models occasionally trail.
          ...(json ? { response_format: JSON_OBJECT_FORMAT } : {}),
        },
        opts.signal ? { signal: opts.signal } : undefined,
      ),
    );
    return (response.choices[0]?.message.content ?? '').trim();
  },
};

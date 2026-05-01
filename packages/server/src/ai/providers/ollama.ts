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
import { getClient } from '../client.js';
import type {
  ChatProvider,
  NormalizedMessage,
  ProviderEvent,
  RunTurnOptions,
} from './types.js';

const AI_MODEL = process.env.AI_MODEL ?? 'qwen2.5:14b';

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

    const response = await client.chat.completions.create({
      model: AI_MODEL,
      messages: toOpenAiMessages(opts.systemPrompt, opts.messages),
      tools,
      temperature: 0.3,
      max_tokens: opts.maxTokens ?? 2048,
    });

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
};

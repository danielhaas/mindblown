/**
 * Provider abstraction for the in-app chat.
 *
 * The chat tool-use loop is provider-agnostic: it builds NormalizedMessage[],
 * hands them to a ChatProvider, consumes ProviderEvent, and translates those
 * into the SSE shape AIChatPanel.tsx expects. Each provider handles its own
 * SDK quirks (OpenAI-style function calls vs Anthropic content blocks) and
 * normalizes the output.
 */

import type { ToolSpec } from '@mindblown/tool-kit';

export interface NormalizedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type NormalizedMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: NormalizedToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCall: NormalizedToolCall }
  | { type: 'turn_end'; reason: 'stop' | 'tool_use' | 'max_tokens' | 'other' };

export interface RunTurnOptions {
  systemPrompt: string;
  messages: NormalizedMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export type ProviderName = 'ollama' | 'anthropic';

export interface ChatProvider {
  readonly name: ProviderName;
  /** Human-facing model label, surfaced in the chat header. */
  readonly model: string;
  runTurn(opts: RunTurnOptions): AsyncIterable<ProviderEvent>;
}

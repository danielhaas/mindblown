/**
 * Provider resolver — picks which ChatProvider handles a given chat request.
 *
 * Priority order:
 *   1. DB preference (system_settings → ai_provider) when configured
 *   2. Auto / env fallback: Anthropic if its key is set, otherwise Ollama
 *
 * The DB preference is a *preference*, not a hard pin: if the user picked
 * Anthropic but the API key isn't set, we fall back to Ollama and surface
 * that mismatch via providerStatus().
 *
 * With a local model configured, Claude never fails on its own: a call it
 * refuses for an outage-type reason (credit, key, rate limit, overload,
 * network) goes to the local model, and Claude is skipped while the outage
 * lasts (fallback.ts).
 */

import { aiEnabled } from '../client.js';
import { ollamaProvider } from './ollama.js';
import { anthropicProvider, anthropicAvailable } from './anthropic.js';
import { getAiProviderSettings, type AiProviderPreference } from '../../db/settings.js';
import { claudeOutage, withLocalFallback, type ClaudeOutage } from './fallback.js';
import type { ChatProvider, ProviderName } from './types.js';

export type { ChatProvider, ProviderName, NormalizedMessage, ProviderEvent } from './types.js';

let claudeWithLocalFallback: ChatProvider | null = null;

/** Claude as handed out: behind the local model when there is one, skipped during an outage. */
function claude(): ChatProvider {
  if (!aiEnabled) return anthropicProvider;
  if (claudeOutage()) return ollamaProvider;
  claudeWithLocalFallback ??= withLocalFallback(anthropicProvider, ollamaProvider);
  return claudeWithLocalFallback;
}

/** Pick a provider given a preference, honoring availability. */
export function pickProvider(preference: AiProviderPreference): ChatProvider | null {
  if (preference === 'anthropic' && anthropicAvailable) return claude();
  if (preference === 'ollama' && aiEnabled) return ollamaProvider;
  // Auto, or the preferred backend isn't available — fall back.
  if (anthropicAvailable) return claude();
  if (aiEnabled) return ollamaProvider;
  return null;
}

export async function resolveProvider(): Promise<ChatProvider> {
  const settings = await getAiProviderSettings();
  const provider = pickProvider(settings.preference);
  if (!provider) {
    throw new Error(
      'No chat provider configured — set ANTHROPIC_API_KEY or AI_BASE_URL',
    );
  }
  return provider;
}

export interface ProviderStatus {
  /** What the chat will actually use right now. */
  active: { name: ProviderName; model: string } | null;
  /** Stored DB preference. */
  preference: AiProviderPreference;
  /** Whether the user's preference is what's actually active. */
  preferenceHonored: boolean;
  /** Per-backend availability — true when its env credentials are set. */
  available: { ollama: boolean; anthropic: boolean };
  /** Default model per backend, for UI display. */
  models: { ollama: string | null; anthropic: string | null };
  /** Claude is being skipped for the local model until `until` (fallback.ts). */
  claudeOutage: { reason: string; until: string } | null;
}

export async function providerStatus(): Promise<ProviderStatus> {
  const settings = await getAiProviderSettings();
  const provider = pickProvider(settings.preference);
  const honored =
    settings.preference === 'auto' ||
    (settings.preference === 'anthropic' && (provider?.name === 'anthropic' || !!claudeOutage())) ||
    (settings.preference === 'ollama' && provider?.name === 'ollama');
  return {
    active: provider ? { name: provider.name, model: provider.model } : null,
    preference: settings.preference,
    preferenceHonored: honored,
    available: { ollama: aiEnabled, anthropic: anthropicAvailable },
    models: {
      ollama: aiEnabled ? ollamaProvider.model : null,
      anthropic: anthropicAvailable ? anthropicProvider.model : null,
    },
    claudeOutage: outageJson(claudeOutage()),
  };
}

function outageJson(o: ClaudeOutage | null): { reason: string; until: string } | null {
  return o ? { reason: o.reason, until: o.until.toISOString() } : null;
}

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
 */

import { aiEnabled } from '../client.js';
import { ollamaProvider } from './ollama.js';
import { anthropicProvider, anthropicAvailable } from './anthropic.js';
import { getAiProviderSettings, type AiProviderPreference } from '../../db/settings.js';
import type { ChatProvider, ProviderName } from './types.js';

export type { ChatProvider, ProviderName, NormalizedMessage, ProviderEvent } from './types.js';

/** Pick a provider given a preference, honoring availability. */
function pickProvider(preference: AiProviderPreference): ChatProvider | null {
  if (preference === 'anthropic' && anthropicAvailable) return anthropicProvider;
  if (preference === 'ollama' && aiEnabled) return ollamaProvider;
  // Auto, or the preferred backend isn't available — fall back.
  if (anthropicAvailable) return anthropicProvider;
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
}

export async function providerStatus(): Promise<ProviderStatus> {
  const settings = await getAiProviderSettings();
  const provider = pickProvider(settings.preference);
  const honored =
    settings.preference === 'auto' ||
    (settings.preference === 'anthropic' && provider?.name === 'anthropic') ||
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
  };
}

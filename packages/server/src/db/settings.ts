/**
 * System-wide key/value settings — currently hosts the registration policy
 * but intentionally generic so other global toggles can reuse the table.
 */

import { eq } from 'drizzle-orm';
import { db } from './connection.js';
import { systemSettings } from './schema.js';

export type RegistrationMode = 'open' | 'invite_only' | 'allowlist';

export interface RegistrationPolicy {
  mode: RegistrationMode;
  /** Used only when mode === 'allowlist'. Entries may be full emails or "@domain". */
  allowlist: string[];
}

/** Secure default: no one can register except via an existing map invite. */
const DEFAULT_POLICY: RegistrationPolicy = {
  mode: 'invite_only',
  allowlist: [],
};

const REGISTRATION_POLICY_KEY = 'registration_policy';

function normalizePolicy(raw: unknown): RegistrationPolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POLICY };
  const r = raw as Record<string, unknown>;
  const mode: RegistrationMode =
    r.mode === 'open' || r.mode === 'invite_only' || r.mode === 'allowlist'
      ? r.mode
      : DEFAULT_POLICY.mode;
  const allowlist = Array.isArray(r.allowlist)
    ? r.allowlist.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    : [];
  return { mode, allowlist };
}

export async function getRegistrationPolicy(): Promise<RegistrationPolicy> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, REGISTRATION_POLICY_KEY))
    .limit(1);
  if (!row) return { ...DEFAULT_POLICY };
  return normalizePolicy(row.value);
}

export async function setRegistrationPolicy(policy: RegistrationPolicy): Promise<RegistrationPolicy> {
  const normalized = normalizePolicy(policy);
  const now = new Date();
  // Upsert — either insert or update the existing row.
  const [existing] = await db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, REGISTRATION_POLICY_KEY))
    .limit(1);
  if (existing) {
    await db
      .update(systemSettings)
      .set({ value: normalized, updatedAt: now })
      .where(eq(systemSettings.key, REGISTRATION_POLICY_KEY));
  } else {
    await db.insert(systemSettings).values({
      key: REGISTRATION_POLICY_KEY,
      value: normalized,
      updatedAt: now,
    });
  }
  return normalized;
}

// ── AI provider preference ────────────────────────────────────────
//
// Controls which chat backend the in-app assistant routes to.
//   - 'auto'      → use whatever's configured (Anthropic preferred when its
//                   key is set; falls back to Ollama otherwise)
//   - 'ollama'    → force the local OpenAI-compatible backend
//   - 'anthropic' → force the Claude API
//
// The resolver still falls back to an available backend if the preferred
// one isn't configured — the setting is a preference, not a hard pin.

export type AiProviderPreference = 'auto' | 'ollama' | 'anthropic';

export interface AiProviderSettings {
  preference: AiProviderPreference;
}

const DEFAULT_AI_PROVIDER: AiProviderSettings = { preference: 'auto' };

const AI_PROVIDER_KEY = 'ai_provider';

function normalizeAiProvider(raw: unknown): AiProviderSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AI_PROVIDER };
  const r = raw as Record<string, unknown>;
  const preference: AiProviderPreference =
    r.preference === 'auto' || r.preference === 'ollama' || r.preference === 'anthropic'
      ? r.preference
      : DEFAULT_AI_PROVIDER.preference;
  return { preference };
}

export async function getAiProviderSettings(): Promise<AiProviderSettings> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, AI_PROVIDER_KEY))
    .limit(1);
  if (!row) return { ...DEFAULT_AI_PROVIDER };
  return normalizeAiProvider(row.value);
}

export async function setAiProviderSettings(
  settings: AiProviderSettings,
): Promise<AiProviderSettings> {
  const normalized = normalizeAiProvider(settings);
  const now = new Date();
  const [existing] = await db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, AI_PROVIDER_KEY))
    .limit(1);
  if (existing) {
    await db
      .update(systemSettings)
      .set({ value: normalized, updatedAt: now })
      .where(eq(systemSettings.key, AI_PROVIDER_KEY));
  } else {
    await db.insert(systemSettings).values({
      key: AI_PROVIDER_KEY,
      value: normalized,
      updatedAt: now,
    });
  }
  return normalized;
}

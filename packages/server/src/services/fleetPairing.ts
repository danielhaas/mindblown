/**
 * Pairing a machine with MindBlown (#506), like signing in a TV:
 *
 *   1. The worker registers without a credential (hostname, agent, slots)
 *      and gets a short code to show on the machine plus a secret it keeps.
 *   2. The owner types the code into MindBlown on a web session and picks a
 *      new fleet (named after the host) or one of their own (re-pair).
 *   3. The worker polls with its secret and collects the fleet key once.
 *
 * The code goes from the machine to the person, never back, so a worker
 * can't confirm itself. Guessing someone else's code would hand their
 * machine your tickets, so codes carry ~40 bits, live 10 minutes, and wrong
 * guesses are limited per user. Only hashes of code and secret are stored.
 *
 * Phase 2 (sharing fleets) keeps this flow: "may you use this fleet?" is
 * the ownership check in confirm.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import * as pairingDb from '../db/fleetPairings.js';
import * as fleetDb from '../db/fleets.js';
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../lib/apiKeys.js';
import { requireFleetOwner, type FleetAccessError } from './fleets.js';

/** No I, L, O, 0, 1: a code is read off a terminal and typed by hand. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60 * 1000;
/** After confirmation the machine has this long to collect its key. */
export const COLLECT_TTL_MS = 60 * 60 * 1000;
export const POLL_AFTER_SECONDS = 5;
export const MAX_SLOTS = 16;

/** Unauthenticated registrations: this many open codes at once, this many per window. */
const MAX_PENDING = 20;
const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const MAX_REGISTRATIONS_PER_WINDOW = 30;
/** Wrong codes one user may type per window before 429. */
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 10;

const registrations: number[] = [];
const failures = new Map<string, number[]>();

export function _resetPairingLimitsForTests(): void {
  registrations.length = 0;
  failures.clear();
}

export type PairingError = { status: number; code: string; message: string };
export const isPairingError = (v: unknown): v is PairingError =>
  typeof v === 'object' && v !== null && 'status' in v && 'code' in v && 'message' in v;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Upper case, separators dropped — what the owner types may be "abcd efgh". */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function drawCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** How the code is shown: ABCD-EFGH. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

function withinWindow(stamps: number[], windowMs: number, now: number): number[] {
  return stamps.filter((t) => now - t < windowMs);
}

export interface MachineInfo {
  hostname: string;
  agent: string | null;
  model: string | null;
  slots: number;
}

export function validateMachine(body: Record<string, unknown>): MachineInfo | string {
  const { hostname, agent, model, slots } = body;
  if (typeof hostname !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(hostname)) {
    return 'hostname is required: letters, digits, ".", "_" or "-", at most 100 characters';
  }
  if (agent !== undefined && agent !== null && (typeof agent !== 'string' || agent.length > 50)) return 'agent must be a string of at most 50 characters';
  if (model !== undefined && model !== null && (typeof model !== 'string' || model.length > 100)) return 'model must be a string of at most 100 characters';
  if (slots !== undefined && (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS)) {
    return `slots must be an integer from 1 to ${MAX_SLOTS}`;
  }
  return {
    hostname,
    agent: typeof agent === 'string' && agent.trim() ? agent.trim() : null,
    model: typeof model === 'string' && model.trim() ? model.trim() : null,
    slots: (slots as number | undefined) ?? 1,
  };
}

/** Step 1 — the machine registers. The plaintext code and secret leave the server once, here. */
export async function registerMachine(
  machine: MachineInfo,
  now = new Date(),
): Promise<{ id: string; code: string; secret: string; expiresAt: string; pollAfterSeconds: number } | PairingError> {
  const t = now.getTime();
  const recent = withinWindow(registrations, REGISTER_WINDOW_MS, t);
  registrations.splice(0, registrations.length, ...recent);
  if (recent.length >= MAX_REGISTRATIONS_PER_WINDOW) {
    return { status: 429, code: 'TOO_MANY_PAIRINGS', message: 'Too many pairing requests; try again in a few minutes' };
  }
  await pairingDb.prunePairings(now);
  if ((await pairingDb.countPendingPairings(now)) >= MAX_PENDING) {
    return { status: 429, code: 'TOO_MANY_PAIRINGS', message: 'Too many machines are waiting to be confirmed; try again in a few minutes' };
  }
  registrations.push(t);
  const secret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(t + CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = drawCode();
    const row = await pairingDb.insertPairing({ ...machine, codeHash: sha256(code), secretHash: sha256(secret), expiresAt });
    if (row) return { id: row.id, code: formatCode(code), secret, expiresAt: expiresAt.toISOString(), pollAfterSeconds: POLL_AFTER_SECONDS };
  }
  throw new Error('Could not draw a free pairing code');
}

function noteFailure(userId: string, now: number): void {
  failures.set(userId, [...withinWindow(failures.get(userId) ?? [], FAILURE_WINDOW_MS, now), now]);
}

/** The open pairing behind a typed code, counting wrong guesses against the user. */
async function openPairing(userId: string, rawCode: unknown, now: Date): Promise<pairingDb.PairingRow | PairingError> {
  const t = now.getTime();
  if (withinWindow(failures.get(userId) ?? [], FAILURE_WINDOW_MS, t).length >= MAX_FAILURES_PER_WINDOW) {
    return { status: 429, code: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong codes; wait a few minutes' };
  }
  const code = typeof rawCode === 'string' ? normalizeCode(rawCode) : '';
  const row = code.length === CODE_LENGTH ? await pairingDb.findOpenPairingByCode(sha256(code), now) : null;
  if (!row) {
    noteFailure(userId, t);
    return { status: 404, code: 'PAIRING_NOT_FOUND', message: 'No machine is waiting with this code. Codes are valid for 10 minutes — check the code shown on the machine.' };
  }
  return row;
}

const machineView = (row: pairingDb.PairingRow) => ({
  hostname: row.hostname,
  agent: row.agent,
  model: row.model,
  slots: row.slots,
  registeredAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

/** Step 2a — the owner checks which machine a code belongs to before confirming. */
export async function lookupPairing(userId: string, rawCode: unknown, now = new Date()) {
  const row = await openPairing(userId, rawCode, now);
  return isPairingError(row) ? row : machineView(row);
}

/**
 * Step 2b — the owner confirms: a new fleet named after the host (or
 * `name`), its cap set to the machine's slots; or `fleetId`, a fleet the
 * user owns, whose other keys go when the machine collects (re-pair).
 */
export async function confirmPairing(
  userId: string,
  input: { code?: unknown; fleetId?: unknown; name?: unknown },
  now = new Date(),
): Promise<{ fleetId: string; fleetName: string; created: boolean; machine: ReturnType<typeof machineView> } | PairingError | FleetAccessError> {
  if (input.fleetId !== undefined && typeof input.fleetId !== 'string') {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'fleetId must be a fleet id' };
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'name must be a non-empty string of at most 200 characters' };
  }
  const open = await openPairing(userId, input.code, now);
  if (isPairingError(open)) return open;

  if (typeof input.fleetId === 'string') {
    // Phase 1: a fleet is yours to pair into only if you own it.
    const owned = await requireFleetOwner(userId, input.fleetId);
    if ('status' in owned) return owned;
    const taken = await pairingDb.claimPairing(open.codeHash, userId, owned.id, true, now);
    if (!taken) return { status: 409, code: 'PAIRING_TAKEN', message: 'This code was just confirmed or expired' };
    return { fleetId: owned.id, fleetName: owned.name, created: false, machine: machineView(taken) };
  }

  // A fleet key can't own fleets (#481); refuse before the code is taken.
  if (await fleetDb.isFleetUser(userId)) return { status: 403, code: 'FORBIDDEN', message: 'A fleet key cannot pair machines' };
  const taken = await pairingDb.claimPairing(open.codeHash, userId, null, false, now);
  if (!taken) return { status: 409, code: 'PAIRING_TAKEN', message: 'This code was just confirmed or expired' };
  const name = typeof input.name === 'string' ? input.name.trim() : taken.hostname;
  try {
    const fleet = await fleetDb.createFleet({ name, ownerId: userId, maxActiveClaims: taken.slots });
    await pairingDb.setPairingFleet(taken.id, fleet.id);
    return { fleetId: fleet.id, fleetName: fleet.name, created: true, machine: machineView(taken) };
  } catch (err) {
    await pairingDb.releasePairing(taken.id);
    throw err;
  }
}

type CollectResult =
  | { status: 'pending'; expiresAt: string }
  | { status: 'paired'; fleetId: string; fleetName: string; ownerName: string | null; key: string; keyPrefix: string };

/**
 * Step 3 — the machine polls with its secret. Pending until confirmed;
 * then the key, exactly once. An unknown id or a wrong secret is 404,
 * like an expired code, so polling reveals nothing.
 */
export async function collectPairing(id: string, secret: unknown, now = new Date()): Promise<CollectResult | PairingError> {
  const gone: PairingError = { status: 404, code: 'PAIRING_NOT_FOUND', message: 'Unknown or expired pairing — run the pairing again' };
  if (typeof secret !== 'string' || secret === '') return gone;
  const row = await pairingDb.getPairing(id);
  if (!row) return gone;
  const given = Buffer.from(sha256(secret), 'hex');
  if (!timingSafeEqual(given, Buffer.from(row.secretHash, 'hex'))) return gone;
  if (row.collectedAt) return { status: 410, code: 'PAIRING_COLLECTED', message: 'This pairing already handed out its key' };
  if (!row.confirmedAt) {
    return row.expiresAt > now ? { status: 'pending', expiresAt: row.expiresAt.toISOString() } : gone;
  }
  if (now.getTime() - row.confirmedAt.getTime() > COLLECT_TTL_MS) return gone;
  // Confirmed, the new fleet not created yet — a moment later it is.
  if (!row.fleetId) return { status: 'pending', expiresAt: row.expiresAt.toISOString() };

  const fleet = await fleetDb.getFleet(row.fleetId);
  const serviceUserId = fleet ? await fleetDb.getServiceUserId(fleet.id) : null;
  if (!fleet || !serviceUserId) return gone;
  if (!(await pairingDb.markCollected(row.id, now))) {
    return { status: 410, code: 'PAIRING_COLLECTED', message: 'This pairing already handed out its key' };
  }
  if (row.replaceKeys) {
    // Re-pair: the machine's new key replaces every key the fleet had.
    for (const k of await listApiKeysForUser(serviceUserId)) {
      if (!k.revokedAt) await revokeApiKey(serviceUserId, k.id);
    }
  }
  const created = await createApiKey(serviceUserId, `${row.hostname} (paired ${now.toISOString().slice(0, 10)})`);
  return {
    status: 'paired',
    fleetId: fleet.id,
    fleetName: fleet.name,
    ownerName: await pairingDb.getUserName(fleet.ownerId),
    key: created.key,
    keyPrefix: created.prefix,
  };
}

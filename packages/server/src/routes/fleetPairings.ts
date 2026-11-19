/**
 * Pairing a machine (#506) — see services/fleetPairing.ts for the flow.
 *
 *   POST /api/fleet-pairings              — the machine registers (no credential)
 *   POST /api/fleet-pairings/:id/collect  — the machine polls with its secret (no credential)
 *   POST /api/fleet-pairings/lookup       — which machine a code belongs to (web session)
 *   POST /api/fleet-pairings/confirm      — pair it: a new fleet or one you own (web session)
 *
 * Looking up and confirming need a signed-in person: no API key, no
 * long-lived token, no MCP tool — like issuing fleet keys (#481).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAgentRequest } from '../auth.js';
import * as pairing from '../services/fleetPairing.js';

const send = (reply: FastifyReply, e: { status: number; code: string; message: string }) =>
  reply.status(e.status).send({ error: { code: e.code, message: e.message } });

/** A person on a web session; null = the error was sent. */
function personOnly(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.userId) {
    send(reply, { status: 401, code: 'UNAUTHORIZED', message: 'Not authenticated' });
    return null;
  }
  if (isAgentRequest(req)) {
    send(reply, { status: 403, code: 'FORBIDDEN', message: 'Pairing a machine needs a signed-in person. Enter the code in the web UI.' });
    return null;
  }
  return req.userId;
}

export async function fleetPairingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/fleet-pairings', async (req, reply) => {
    const machine = pairing.validateMachine((req.body ?? {}) as Record<string, unknown>);
    if (typeof machine === 'string') return send(reply, { status: 400, code: 'VALIDATION_ERROR', message: machine });
    const result = await pairing.registerMachine(machine);
    if (pairing.isPairingError(result)) return send(reply, result);
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string }; Body: { secret?: unknown } }>('/api/fleet-pairings/:id/collect', async (req, reply) => {
    const result = await pairing.collectPairing(req.params.id, req.body?.secret);
    if (pairing.isPairingError(result)) return send(reply, result);
    return reply.status(result.status === 'pending' ? 202 : 200).send(result);
  });

  app.post<{ Body: { code?: unknown } }>('/api/fleet-pairings/lookup', async (req, reply) => {
    const userId = personOnly(req, reply);
    if (!userId) return reply;
    const result = await pairing.lookupPairing(userId, req.body?.code);
    return pairing.isPairingError(result) ? send(reply, result) : reply.send(result);
  });

  app.post<{ Body: { code?: unknown; fleetId?: unknown; name?: unknown; replaceKeys?: unknown } }>('/api/fleet-pairings/confirm', async (req, reply) => {
    const userId = personOnly(req, reply);
    if (!userId) return reply;
    const result = await pairing.confirmPairing(userId, req.body ?? {});
    return 'status' in result ? send(reply, result) : reply.send(result);
  });
}

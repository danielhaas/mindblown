/**
 * The kanban board at a glance (#589).
 *
 *   GET /api/maps/:id/board-summary?limit=  — in progress, blocked (with why),
 *                                             WIP vs limit, waiting for review
 *
 * What the Android home-screen widget reads on every refresh: one small
 * JSON instead of the whole map. The rules are core's `summarizeBoard`;
 * this route owns access (view on the map), the `limit` param (1–20,
 * default 5) and the 404.
 */
import type { FastifyInstance } from 'fastify';
import { summarizeBoard, BOARD_SUMMARY_DEFAULT_LIMIT } from '@mindblown/core';
import { requireMapAccess } from '../lib/mapAccess.js';
import * as mapDb from '../db/maps.js';

const MAX_LIMIT = 20;

export async function boardRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/maps/:id/board-summary',
    async (req, reply) => {
      if (!(await requireMapAccess(req, reply, req.params.id, 'view'))) return reply;

      let limit = BOARD_SUMMARY_DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: `limit must be an integer 1–${MAX_LIMIT}` },
          });
        }
      }

      const data = await mapDb.getMap(req.params.id);
      if (!data) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
        });
      }
      return summarizeBoard(data.map, data.nodes, { limit });
    },
  );
}

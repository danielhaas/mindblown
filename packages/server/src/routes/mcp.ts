/**
 * HTTP-hosted MCP endpoint.
 *
 * Replaces the stdio `@mindblown/mcp` binary as the canonical entry point
 * for Claude Code (and any other MCP client). The schema is owned by the
 * deployed API server — clients automatically pick up new tools when
 * `mind.project.li` redeploys, instead of having to `pnpm install` an
 * updated stdio binary on every developer's machine.
 *
 * Authentication: `Authorization: Bearer mb_<API-KEY>` (minted at
 * /api/api-keys by the user via Settings → API keys). Session JWTs are
 * NOT accepted here — the auth surface for headless MCP clients is
 * explicitly the API-key scheme. Cache hit rate is high since the
 * api-keys library has a 60s LRU.
 *
 * Transport: MCP Streamable HTTP, stateless mode. Each POST is an
 * independent JSON-RPC request → JSON response, no session management,
 * no SSE coupling. Stateless mode is sufficient because the MCP server
 * we expose has no per-connection state (every tool call is pure
 * RPC + DB). Picking stateless avoids the cross-instance session
 * affinity problem if/when we scale out behind a load balancer.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMindblownMcpServer, runWithApiContext } from '@mindblown/mcp';
import { API_KEY_PREFIX, validateApiKey } from '../lib/apiKeys.js';
import { signToken } from '../auth.js';

/**
 * Loopback base URL the MCP tool handlers' fetch() calls should target.
 * Default points to the same Fastify process by 127.0.0.1 — the MCP route
 * runs inside the server, so going out the network stack and back in is
 * silly but reuses every existing route's permission checks unchanged.
 * Configurable via env so tests can pin a port.
 */
function loopbackBaseUrl(_req: FastifyRequest): string {
  if (process.env.MINDBLOWN_INTERNAL_API_URL) {
    return process.env.MINDBLOWN_INTERNAL_API_URL;
  }
  const port = parseInt(process.env.PORT ?? '3001', 10);
  return `http://127.0.0.1:${port}`;
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /mcp ─ MCP Streamable HTTP transport ──────────────────
  //
  // Stateless mode. Each request is fully handled in its own scope: we
  // build a fresh MCP server + transport, bind the per-user context,
  // and tear them down at the end. This keeps memory bounded and lets
  // a multi-instance deploy scale horizontally without sticky sessions.

  const handleMcp = async (req: FastifyRequest, reply: FastifyReply) => {
    // Validate the API-key Bearer (auth middleware already attached
    // userId if it was a valid key, but we tighten here: /mcp ONLY
    // accepts API keys, not session JWTs).
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authorization header required' },
        id: null,
      });
    }
    const token = authHeader.slice(7);
    if (!token.startsWith(API_KEY_PREFIX)) {
      return reply.status(401).send({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'INVALID_API_KEY — /mcp accepts only mb_… API keys. Generate one at /settings/api-keys.',
        },
        id: null,
      });
    }
    const validated = await validateApiKey(token);
    if (!validated) {
      return reply.status(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'INVALID_API_KEY' },
        id: null,
      });
    }

    // The MCP tool handlers in @mindblown/mcp call the REST API via
    // fetch. We need them to act as the user identified by the API
    // key. Mint a short-lived JWT for the user and bind it as the
    // Authorization for the loopback calls via AsyncLocalStorage.
    //
    // Why a fresh JWT instead of forwarding the API key? Because the
    // mcp api client just shoves whatever it's given into the Bearer
    // header, and we want loopback calls to take the JWT codepath in
    // middleware (zero new branches, single source of truth on
    // authentication semantics).
    // Sentinel email — the loopback JWT is consumed by our own middleware
    // and never echoed back to a user-visible surface. Stamping a marker
    // string (vs. an empty string or a real DB lookup) keeps audit logs
    // honest about where the request originated without burning a DB
    // query per /mcp call. If we ever need the real email for an audit
    // surface, swap this to `await fetchUserEmail(validated.userId)`.
    const loopbackJwt = signToken({ userId: validated.userId, email: 'api-key-loopback' });
    const baseUrl = loopbackBaseUrl(req);

    // Build a fresh MCP server + stateless transport for this request.
    const mcpServer = createMindblownMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // simple req/resp; no SSE
    });

    // Hold off on flushing Fastify's reply — the SDK transport writes
    // directly to res. Tell Fastify not to manage the response.
    reply.hijack();

    try {
      await mcpServer.connect(transport);
      await runWithApiContext({ baseUrl, token: loopbackJwt }, async () => {
        await transport.handleRequest(req.raw, reply.raw, req.body);
      });
    } catch (err) {
      console.error('[mcp] handleRequest failed:', err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal MCP server error' },
            id: null,
          }),
        );
      } else {
        reply.raw.end();
      }
    } finally {
      // Best-effort cleanup.
      try {
        await transport.close();
      } catch {
        /* noop */
      }
      try {
        await mcpServer.close();
      } catch {
        /* noop */
      }
    }
  };

  app.post('/mcp', handleMcp);
  // Streamable HTTP transport spec also supports GET for the standalone
  // SSE channel; since we're stateless + JSON-only we just return 405
  // for GET so misconfigured clients get a clear error instead of a
  // hang.
  app.get('/mcp', async (_req, reply) => {
    return reply.status(405).send({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'MCP endpoint is POST-only (stateless JSON mode). GET / SSE not supported.',
      },
      id: null,
    });
  });
}

/**
 * Management-information tools for the in-app chat.
 *
 * The MI suite ("when will it be done?", "how much is left?", "what is at
 * risk?") lives in @mindblown/mcp, not in the shared tool-kit — it is built
 * on the REST client there. The chat panel is the primary MI surface, so
 * instead of porting ~1500 lines it reuses the very same handlers: build the
 * MCP server once in-process, look the read-only MI tools up by name, and run
 * them inside `runWithApiContext` as the chat user — exactly the path a
 * `/mcp` request takes, minus the transport.
 */

import type { z } from 'zod';
import {
  createMindblownMcpServer,
  runWithApiContext,
  type Injector,
} from '@mindblown/mcp';
import { signToken } from '../auth.js';

/** Read-only MI tools the chat may call. None of them writes to the map. */
export const MI_CHAT_TOOL_NAMES = [
  'completion_forecast',
  'remaining_work',
  'risk_scan',
  'status_digest',
  'alert_digest',
  'blocked_digest',
  'burnup',
  'scope_simulate',
  'change_history',
  'velocity_report',
  'forecast_scorecard',
  'get_estimation_accuracy',
  'get_schedule',
  'get_wip_status',
  'list_versions',
  'plan_lint',
  'requirements_overview',
] as const;

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * The subset of the SDK's RegisteredTool we rely on. McpServer keeps its
 * registry private; `miTools.test.ts` pins that every MI name resolves, so an
 * SDK upgrade that moves it fails a test instead of silently emptying chat.
 */
interface RegisteredMcpTool {
  description?: string;
  inputSchema?: z.ZodObject<z.ZodRawShape>;
  handler: (args: unknown, extra: unknown) => Promise<McpToolResult>;
}

export interface MiChatTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  run: (args: Record<string, unknown>, ctx: MiToolContext) => Promise<string>;
}

export interface MiToolContext {
  userId: string;
  mapId: string;
  /** In-process `app.inject`; omitted → loopback HTTP to the API port. */
  injector?: Injector;
}

function loopbackBaseUrl(): string {
  return process.env.MINDBLOWN_INTERNAL_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
}

function toText(result: McpToolResult): string {
  return (result.content ?? [])
    .map((c) => c.text ?? '')
    .filter(Boolean)
    .join('\n');
}

let cache: MiChatTool[] | null = null;

/** The MI tools, built from the in-process MCP server on first use. */
export function getMiChatTools(): MiChatTool[] {
  if (cache) return cache;
  const server = createMindblownMcpServer();
  const registry = (server as unknown as { _registeredTools: Record<string, RegisteredMcpTool> })
    ._registeredTools;
  cache = MI_CHAT_TOOL_NAMES.flatMap((name): MiChatTool[] => {
    const tool = registry[name];
    if (!tool?.inputSchema) return [];
    const inputSchema = tool.inputSchema;
    return [
      {
        name,
        description: tool.description ?? name,
        schema: inputSchema.shape,
        run: async (args, ctx) => {
          // The model sometimes omits mapId; the chat is always about one map.
          const parsed = inputSchema.safeParse({ ...args, mapId: ctx.mapId });
          if (!parsed.success) {
            return `Error: invalid arguments for ${name}: ${parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')}`;
          }
          // Same loopback identity the /mcp route mints: a robot JWT for the
          // user, so every route-level permission check still applies.
          const token = signToken({ userId: ctx.userId, email: 'chat-loopback', kind: 'loopback' });
          const result = await runWithApiContext(
            { baseUrl: loopbackBaseUrl(), token, injector: ctx.injector },
            () => tool.handler(parsed.data, {}),
          );
          return toText(result) || `${name} returned no output.`;
        },
      },
    ];
  });
  return cache;
}

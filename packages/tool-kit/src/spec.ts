import type { z } from 'zod';
import type { ToolBackend } from './backend.js';

/**
 * A tool handler returns a single plain-text string. MCP wraps it in its content
 * envelope; the in-app chat returns it to the frontend as-is.
 *
 * Handlers should NEVER throw for expected errors (not-found, validation, etc) —
 * instead return a human-readable error string. Adapters catch thrown exceptions
 * from the backend and format them separately.
 */
export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  handler: (
    backend: ToolBackend,
    args: z.objectOutputType<S, z.ZodTypeAny>,
  ) => Promise<string>;
}

/** Helper to preserve the generic schema type when exporting a spec list. */
export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

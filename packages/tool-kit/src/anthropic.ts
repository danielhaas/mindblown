/**
 * Convert a ToolSpec to an Anthropic-compatible tool definition.
 * Used by the in-app chat when routed to the Anthropic provider.
 *
 * Anthropic's tool shape differs from OpenAI's:
 *   - flat `name`/`description`/`input_schema` (no `type: "function"` wrapper)
 *   - `input_schema` instead of `parameters`
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolSpec } from './spec.js';

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function specToAnthropicTool(spec: ToolSpec): AnthropicTool {
  const objectSchema = z.object(spec.schema);
  const jsonSchema = zodToJsonSchema(objectSchema, { target: 'openApi3' }) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    input_schema: jsonSchema,
  };
}

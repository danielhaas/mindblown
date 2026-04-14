/**
 * Convert a ToolSpec to an OpenAI-compatible function-calling definition.
 * Used by the in-app chat panel which talks to Ollama (OpenAI-compatible API).
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolSpec } from './spec.js';

export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function specToOpenAiTool(spec: ToolSpec): OpenAiTool {
  const objectSchema = z.object(spec.schema);
  const jsonSchema = zodToJsonSchema(objectSchema, { target: 'openApi3' }) as Record<string, unknown>;
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: jsonSchema,
    },
  };
}

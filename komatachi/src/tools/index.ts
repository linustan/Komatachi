/**
 * Tool Registry Module
 *
 * Defines the agent's tools as a flat array of definitions.
 * Each tool has a name, description, input schema, and handler.
 * The registry IS the policy -- every tool in the array is available.
 *
 * Design principles:
 * - Flat array, no profiles or permissions
 * - Handler stays on our side; API gets name + description + schema
 * - Result type uses discriminated union (ok/error)
 * - No dynamic enabling/disabling, no groups, no allow/deny lists
 */

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * JSON Schema for tool input parameters.
 * A subset of JSON Schema sufficient for Claude API tool definitions.
 */
export interface JsonSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/**
 * Result from executing a tool handler.
 *
 * Discriminated union: either success with content or error with message.
 * Maps to Rust's Result<String, String>.
 */
export type ToolResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

/**
 * A tool available to the agent.
 *
 * name, description, and inputSchema define what the tool does.
 * handler is the function that executes it.
 */
export interface ToolDefinition {
  /** Tool name (must match what Claude uses in tool_use blocks) */
  readonly name: string;
  /** Human-readable description of what the tool does */
  readonly description: string;
  /** JSON Schema for the tool's input parameters */
  readonly inputSchema: JsonSchema;
  /** Function that executes the tool and returns a result */
  readonly handler: (input: unknown) => Promise<ToolResult>;
}

/**
 * Claude API tool definition format.
 * This is what gets sent in the API request's `tools` parameter.
 * Does not include the handler (that stays on our side).
 */
export interface ApiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
}

// -----------------------------------------------------------------------------
// Functions
// -----------------------------------------------------------------------------

/**
 * Export tool definitions for the Claude API.
 *
 * Strips handler functions, returning only the API-facing fields.
 * The result is directly usable as the `tools` parameter in a
 * Claude API messages.create() call.
 */
export function exportForApi(
  tools: readonly ToolDefinition[]
): ApiToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/**
 * Find a tool by name.
 *
 * Returns the tool definition or undefined if not found.
 * Used by the Agent Loop to dispatch tool_use blocks.
 */
export function findTool(
  tools: readonly ToolDefinition[],
  name: string
): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}

/**
 * Execute a tool handler and return a structured result.
 *
 * Catches any thrown errors and wraps them as error results.
 * This ensures the Agent Loop always gets a ToolResult, never an exception.
 */
export async function executeTool(
  tool: ToolDefinition,
  input: unknown
): Promise<ToolResult> {
  try {
    return await tool.handler(input);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

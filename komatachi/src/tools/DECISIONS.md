# Tool Registry Module Decisions

Architectural decisions made during the distillation of the Tool Registry module.

## What We Preserved

### Tool definition structure
OpenClaw's tool definitions have name, description, input schema, and handler. This is the essential minimum. Preserved as-is.

### API export function
OpenClaw exports tool definitions for the Claude API by stripping internal fields (handler). Preserved as `exportForApi()`.

## What We Omitted

### Tool groups and profiles (234+ LOC in OpenClaw)
OpenClaw organizes tools into profiles (minimal/coding/full) with group-based enabling. With one agent and one set of tools, the array IS the policy. No groups, no profiles.

### Allow/deny lists and permissions
OpenClaw gates tool access based on channel, user, and agent configuration. Single-agent, single-conversation: every tool in the array is available.

### Dynamic tool enabling/disabling
OpenClaw enables/disables tools mid-conversation based on context. Not needed for the minimal agent.

### Plugin tool discovery
OpenClaw discovers tools from plugins and extensions. No plugin system.

### Tool usage analytics
OpenClaw tracks tool usage statistics. Not a core concern for the minimal agent.

## Design Decisions

### Flat array, not a registry class
Tools are a plain array of `ToolDefinition` objects. No wrapper class, no registry pattern. Functions like `findTool()` and `exportForApi()` operate on the array directly. This is maximally simple and Rust-compatible (a `Vec<ToolDefinition>`).

### executeTool wraps handler exceptions
`executeTool()` catches any thrown error from the handler and converts it to an error `ToolResult`. This ensures the Agent Loop always gets a structured result, never an unhandled exception from a tool. The tool dispatch loop doesn't need try/catch.

### ToolResult as discriminated union
`ToolResult = { ok: true, content: string } | { ok: false, error: string }`. This maps directly to Rust's `Result<String, String>` and is easy to pattern-match. The Agent Loop checks `result.ok` to determine success/failure.

### JsonSchema type is minimal
The `JsonSchema` type is a minimal subset of JSON Schema sufficient for Claude API tool definitions. It's typed as `type: "object"` with optional properties, required, and additionalProperties. Full JSON Schema support is unnecessary -- tool inputs are always objects.

### findTool is a plain function
Tool lookup is a linear scan (`Array.find`). With a small number of tools (typically < 20), this is more than fast enough. A Map-based lookup can be added if needed without changing the interface.

### inputSchema (camelCase) to input_schema (snake_case) mapping
Our internal type uses `inputSchema` (TypeScript convention). The API export maps this to `input_schema` (Claude API convention). This keeps our code idiomatic while producing correct API payloads.

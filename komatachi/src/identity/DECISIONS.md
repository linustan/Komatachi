# System Prompt (Identity) Module Decisions

Architectural decisions made during the distillation of the System Prompt module.

## What We Preserved

### Identity file concept
OpenClaw's bootstrap file system is one of its best ideas: user-editable markdown files that define the agent's sense of self. Simple, auditable, directly serving the vision of persistent AI entities with evolving identity. Preserved and named explicitly: SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, TOOLS.md.

### Section builder pattern
OpenClaw uses section builders that each produce a portion of the system prompt. The ordered composition pattern is sound: each builder is responsible for one concern, and the assembly order is explicit. Preserved with a fixed list of builders (identity, tools, runtime, memory, guidelines).

### Tools in system prompt
OpenClaw includes tool descriptions in the system prompt. This helps the agent understand what it can do. Preserved as a tools section with name + description pairs, plus optional TOOLS.md notes.

## What We Omitted

### Section registry / dynamic add-replace (OpenClaw)
OpenClaw allows plugins to register and replace system prompt sections dynamically. With no plugins and a single agent, the section list is known at compile time. A registry adds indirection without value.

### Plugin hooks for prompt modification
OpenClaw allows extensions to modify the prompt. Dropped per Decision #2 (no plugin hooks for core behavior).

### Skills/capability injection
OpenClaw injects available skills into the system prompt. Skills are an extension concept. Dropped.

### Dynamic prompt adjustment based on conversation state
OpenClaw adjusts the prompt based on conversation context (e.g., project type). The minimal agent's prompt is built fresh each turn from identity files + tools + runtime. If identity files change between turns, the next turn picks up the changes naturally.

### Template engine (Decision #15)
String interpolation via template literals is sufficient. The dynamic content is simple (timestamps, tool lists, identity file contents). No template engine needed.

### Project detection / workspace context (Decision #18)
Coding-assistant concern, not core agent identity. The agent knows who it is (identity files) and what it can do (tools). What project it's in is a future capability module.

### Template initialization system
OpenClaw creates starter files on first run. The human creates identity files (or asks the agent for help). No automatic bootstrapping.

## Design Decisions

### Module named "identity" not "system-prompt"
The module is named `src/identity/` because it represents the agent's identity, not just an API configuration string. The function `buildSystemPrompt()` produces the API string, but the module's purpose is identity management. This naming reflects the Komatachi vision: "system prompt" is the agent's sense of self.

### loadIdentityFiles reads filesystem directly
Identity files are loaded via `node:fs/promises`, not through the Storage module. This is deliberate: identity files live in the agent's home directory, which may be different from the storage base directory. They are user-edited files, not application-managed data.

### Missing identity files return null, not error
A missing SOUL.md is not an error -- not every agent needs every identity file. The system prompt builder handles null gracefully by omitting the corresponding section. The agent starts minimal and grows as identity files are added.

### Fixed section order
Sections appear in a fixed order: identity, tools, runtime, memory, guidelines. This is predictable and auditable. The order reflects importance: who the agent is comes first, what it can do comes second, when it is comes third, what it remembers comes fourth, how it should behave comes last.

### ToolSummary type, not ToolDefinition
The system prompt builder accepts `ToolSummary` (name + description), not the full `ToolDefinition`. This keeps the identity module independent of the tools module. The Agent Loop converts tool definitions to summaries when building the prompt.

### Content trimmed in sections
File contents are trimmed when included in sections. Trailing newlines and whitespace from file editing don't affect prompt formatting.

### Synchronous file loading
`loadIdentityFiles()` uses `readFileSync` rather than async `readFile`. Identity files are small (typically < 10KB each), and loading happens once per turn. See Storage DECISIONS.md for the full rationale for synchronous I/O.

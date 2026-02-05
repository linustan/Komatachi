/**
 * System Prompt Module (Agent Identity)
 *
 * Assembles the system prompt that defines the agent's sense of self.
 * Loads identity files from the agent's home directory and composes them
 * with tool definitions and runtime metadata.
 *
 * Design principles:
 * - Identity files are user-editable markdown: SOUL.md, IDENTITY.md, etc.
 * - Simple function, not a registry: section builders called in order
 * - String interpolation, no template engine
 * - No plugin hooks for prompt modification
 * - Synchronous I/O: Identity files are small; sync reads are fine
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Contents of the agent's identity files.
 * Each field is the raw markdown content, or null if the file doesn't exist.
 */
export interface IdentityFiles {
  /** SOUL.md - Personality, values, core nature */
  readonly soul: string | null;
  /** IDENTITY.md - Name, characteristics, self-description */
  readonly identity: string | null;
  /** USER.md - Context about the human */
  readonly user: string | null;
  /** MEMORY.md - Long-term curated memory */
  readonly memory: string | null;
  /** AGENTS.md - Behavioral guidelines */
  readonly agents: string | null;
  /** TOOLS.md - Tool-specific notes and instructions */
  readonly tools: string | null;
}

/**
 * Runtime information injected into the system prompt.
 */
export interface RuntimeInfo {
  /** Current timestamp in ISO 8601 format */
  readonly currentTime: string;
}

/**
 * Tool definition for system prompt rendering.
 * Only the fields needed for prompt text (not the handler).
 */
export interface ToolSummary {
  readonly name: string;
  readonly description: string;
}

// -----------------------------------------------------------------------------
// Identity File Loading
// -----------------------------------------------------------------------------

/** The identity files and their expected filenames */
const IDENTITY_FILE_MAP: ReadonlyArray<{
  key: keyof IdentityFiles;
  filename: string;
}> = [
  { key: "soul", filename: "SOUL.md" },
  { key: "identity", filename: "IDENTITY.md" },
  { key: "user", filename: "USER.md" },
  { key: "memory", filename: "MEMORY.md" },
  { key: "agents", filename: "AGENTS.md" },
  { key: "tools", filename: "TOOLS.md" },
];

/**
 * Load identity files from the agent's home directory.
 *
 * Reads each identity file. Missing files return null (not an error --
 * not all agents need all files). Files are read directly from the
 * filesystem, not through Storage, because identity files live outside
 * the storage base directory.
 */
export function loadIdentityFiles(homeDir: string): IdentityFiles {
  const result: Record<string, string | null> = {};

  for (const { key, filename } of IDENTITY_FILE_MAP) {
    const filePath = join(homeDir, filename);
    try {
      result[key] = readFileSync(filePath, "utf-8");
    } catch (error) {
      if (isNotFoundError(error)) {
        result[key] = null;
      } else {
        throw error;
      }
    }
  }

  return result as unknown as IdentityFiles;
}

// -----------------------------------------------------------------------------
// System Prompt Assembly
// -----------------------------------------------------------------------------

/**
 * Build the complete system prompt from identity files, tools, and runtime info.
 *
 * Section builders are called in a fixed order. Each returns lines of text
 * (or empty array to skip). The final prompt is all sections joined with
 * double newlines.
 */
export function buildSystemPrompt(
  identityFiles: IdentityFiles,
  tools: readonly ToolSummary[],
  runtime: RuntimeInfo
): string {
  const sections: string[] = [
    buildIdentitySection(identityFiles),
    buildToolsSection(tools, identityFiles.tools),
    buildRuntimeSection(runtime),
    buildMemorySection(identityFiles),
    buildGuidelinesSection(identityFiles),
  ].filter((section) => section.length > 0);

  return sections.join("\n\n");
}

// -----------------------------------------------------------------------------
// Section Builders
// -----------------------------------------------------------------------------

/**
 * Core identity: who the agent is (SOUL.md, IDENTITY.md, USER.md).
 */
function buildIdentitySection(files: IdentityFiles): string {
  const parts: string[] = [];

  if (files.soul !== null) {
    parts.push(files.soul.trim());
  }

  if (files.identity !== null) {
    parts.push(files.identity.trim());
  }

  if (files.user !== null) {
    parts.push(`## About the User\n\n${files.user.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * Available tools and tool-specific notes.
 */
function buildToolsSection(
  tools: readonly ToolSummary[],
  toolNotes: string | null
): string {
  if (tools.length === 0 && toolNotes === null) {
    return "";
  }

  const parts: string[] = [];

  if (tools.length > 0) {
    const toolList = tools
      .map((t) => `- **${t.name}**: ${t.description}`)
      .join("\n");
    parts.push(`## Available Tools\n\n${toolList}`);
  }

  if (toolNotes !== null) {
    parts.push(toolNotes.trim());
  }

  return parts.join("\n\n");
}

/**
 * Runtime metadata: current time, environment.
 */
function buildRuntimeSection(runtime: RuntimeInfo): string {
  return `## Current Time\n\n${runtime.currentTime}`;
}

/**
 * Long-term curated memory (MEMORY.md).
 */
function buildMemorySection(files: IdentityFiles): string {
  if (files.memory === null) {
    return "";
  }
  return `## Memory\n\n${files.memory.trim()}`;
}

/**
 * Behavioral guidelines (AGENTS.md).
 */
function buildGuidelinesSection(files: IdentityFiles): string {
  if (files.agents === null) {
    return "";
  }
  return `## Guidelines\n\n${files.agents.trim()}`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

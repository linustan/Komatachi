import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIdentityFiles,
  buildSystemPrompt,
  type IdentityFiles,
  type RuntimeInfo,
  type ToolSummary,
} from "./index.js";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "komatachi-identity-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function writeIdentityFile(name: string, content: string): void {
  writeFileSync(join(homeDir, name), content, "utf-8");
}

const emptyIdentity: IdentityFiles = {
  soul: null,
  identity: null,
  user: null,
  memory: null,
  agents: null,
  tools: null,
};

const defaultRuntime: RuntimeInfo = {
  currentTime: "2026-02-05T14:30:00Z",
};

// -----------------------------------------------------------------------------
// loadIdentityFiles
// -----------------------------------------------------------------------------

describe("loadIdentityFiles", () => {
  it("returns null for all files when directory is empty", () => {
    const files = loadIdentityFiles(homeDir);

    expect(files.soul).toBeNull();
    expect(files.identity).toBeNull();
    expect(files.user).toBeNull();
    expect(files.memory).toBeNull();
    expect(files.agents).toBeNull();
    expect(files.tools).toBeNull();
  });

  it("loads SOUL.md when present", () => {
    writeIdentityFile("SOUL.md", "I am curious and kind.");

    const files = loadIdentityFiles(homeDir);

    expect(files.soul).toBe("I am curious and kind.");
    expect(files.identity).toBeNull();
  });

  it("loads all identity files when present", () => {
    writeIdentityFile("SOUL.md", "Soul content");
    writeIdentityFile("IDENTITY.md", "Identity content");
    writeIdentityFile("USER.md", "User content");
    writeIdentityFile("MEMORY.md", "Memory content");
    writeIdentityFile("AGENTS.md", "Agents content");
    writeIdentityFile("TOOLS.md", "Tools content");

    const files = loadIdentityFiles(homeDir);

    expect(files.soul).toBe("Soul content");
    expect(files.identity).toBe("Identity content");
    expect(files.user).toBe("User content");
    expect(files.memory).toBe("Memory content");
    expect(files.agents).toBe("Agents content");
    expect(files.tools).toBe("Tools content");
  });

  it("loads a subset of files (mixed present/absent)", () => {
    writeIdentityFile("SOUL.md", "I exist.");
    writeIdentityFile("MEMORY.md", "I remember things.");

    const files = loadIdentityFiles(homeDir);

    expect(files.soul).toBe("I exist.");
    expect(files.identity).toBeNull();
    expect(files.user).toBeNull();
    expect(files.memory).toBe("I remember things.");
    expect(files.agents).toBeNull();
    expect(files.tools).toBeNull();
  });

  it("preserves whitespace and newlines in file content", () => {
    const content = "Line 1\n\nLine 3\n  Indented\n";
    writeIdentityFile("SOUL.md", content);

    const files = loadIdentityFiles(homeDir);

    expect(files.soul).toBe(content);
  });

  it("handles unicode content", () => {
    writeIdentityFile("IDENTITY.md", "Name: \u6771\u4EAC Bot \u{1F916}");

    const files = loadIdentityFiles(homeDir);

    expect(files.identity).toBe("Name: \u6771\u4EAC Bot \u{1F916}");
  });

  it("ignores non-identity files in the directory", () => {
    writeIdentityFile("SOUL.md", "Soul");
    writeIdentityFile("README.md", "Not an identity file");
    writeIdentityFile("config.json", "{}");

    const files = loadIdentityFiles(homeDir);

    expect(files.soul).toBe("Soul");
    // No properties for non-identity files
    expect(Object.keys(files)).toEqual([
      "soul",
      "identity",
      "user",
      "memory",
      "agents",
      "tools",
    ]);
  });
});

// -----------------------------------------------------------------------------
// buildSystemPrompt - identity section
// -----------------------------------------------------------------------------

describe("buildSystemPrompt - identity", () => {
  it("includes soul content", () => {
    const files = { ...emptyIdentity, soul: "I am curious and kind." };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    expect(prompt).toContain("I am curious and kind.");
  });

  it("includes identity content", () => {
    const files = { ...emptyIdentity, identity: "My name is Koma." };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    expect(prompt).toContain("My name is Koma.");
  });

  it("includes user context with heading", () => {
    const files = { ...emptyIdentity, user: "Linus is a software engineer." };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    expect(prompt).toContain("## About the User");
    expect(prompt).toContain("Linus is a software engineer.");
  });

  it("combines soul and identity in order", () => {
    const files = {
      ...emptyIdentity,
      soul: "SOUL_CONTENT",
      identity: "IDENTITY_CONTENT",
    };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    const soulIndex = prompt.indexOf("SOUL_CONTENT");
    const identityIndex = prompt.indexOf("IDENTITY_CONTENT");
    expect(soulIndex).toBeLessThan(identityIndex);
  });

  it("trims whitespace from file contents", () => {
    const files = { ...emptyIdentity, soul: "  trimmed content  \n\n" };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    expect(prompt).toContain("trimmed content");
    expect(prompt).not.toContain("  trimmed content  \n\n");
  });
});

// -----------------------------------------------------------------------------
// buildSystemPrompt - tools section
// -----------------------------------------------------------------------------

describe("buildSystemPrompt - tools", () => {
  it("includes tool list with names and descriptions", () => {
    const tools: ToolSummary[] = [
      { name: "get_time", description: "Get the current time" },
      { name: "read_file", description: "Read a file's contents" },
    ];

    const prompt = buildSystemPrompt(emptyIdentity, tools, defaultRuntime);

    expect(prompt).toContain("## Available Tools");
    expect(prompt).toContain("**get_time**: Get the current time");
    expect(prompt).toContain("**read_file**: Read a file's contents");
  });

  it("omits tools section when no tools and no TOOLS.md", () => {
    const prompt = buildSystemPrompt(emptyIdentity, [], defaultRuntime);

    expect(prompt).not.toContain("Available Tools");
  });

  it("includes TOOLS.md content alongside tool list", () => {
    const files = {
      ...emptyIdentity,
      tools: "Always prefer read_file over bash cat.",
    };
    const tools: ToolSummary[] = [
      { name: "read_file", description: "Read a file" },
    ];

    const prompt = buildSystemPrompt(files, tools, defaultRuntime);

    expect(prompt).toContain("**read_file**: Read a file");
    expect(prompt).toContain(
      "Always prefer read_file over bash cat."
    );
  });

  it("includes TOOLS.md even with no tool definitions", () => {
    const files = {
      ...emptyIdentity,
      tools: "Tool-specific notes go here.",
    };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    expect(prompt).toContain("Tool-specific notes go here.");
  });
});

// -----------------------------------------------------------------------------
// buildSystemPrompt - runtime section
// -----------------------------------------------------------------------------

describe("buildSystemPrompt - runtime", () => {
  it("includes current time", () => {
    const prompt = buildSystemPrompt(emptyIdentity, [], defaultRuntime);

    expect(prompt).toContain("## Current Time");
    expect(prompt).toContain("2026-02-05T14:30:00Z");
  });

  it("uses the provided timestamp", () => {
    const runtime = { currentTime: "2025-12-25T00:00:00Z" };

    const prompt = buildSystemPrompt(emptyIdentity, [], runtime);

    expect(prompt).toContain("2025-12-25T00:00:00Z");
  });
});

// -----------------------------------------------------------------------------
// buildSystemPrompt - memory and guidelines sections
// -----------------------------------------------------------------------------

describe("buildSystemPrompt - memory", () => {
  it("includes memory content with heading", () => {
    const files = {
      ...emptyIdentity,
      memory: "The user prefers TypeScript.",
    };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("The user prefers TypeScript.");
  });

  it("omits memory section when MEMORY.md is absent", () => {
    const prompt = buildSystemPrompt(emptyIdentity, [], defaultRuntime);

    expect(prompt).not.toContain("## Memory");
  });
});

describe("buildSystemPrompt - guidelines", () => {
  it("includes guidelines content with heading", () => {
    const files = {
      ...emptyIdentity,
      agents: "Be concise. No emojis.",
    };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    expect(prompt).toContain("## Guidelines");
    expect(prompt).toContain("Be concise. No emojis.");
  });

  it("omits guidelines section when AGENTS.md is absent", () => {
    const prompt = buildSystemPrompt(emptyIdentity, [], defaultRuntime);

    expect(prompt).not.toContain("## Guidelines");
  });
});

// -----------------------------------------------------------------------------
// buildSystemPrompt - section ordering
// -----------------------------------------------------------------------------

describe("buildSystemPrompt - section order", () => {
  it("places identity before tools before runtime before memory before guidelines", () => {
    const files: IdentityFiles = {
      soul: "SOUL_MARKER",
      identity: "IDENTITY_MARKER",
      user: "USER_MARKER",
      memory: "MEMORY_MARKER",
      agents: "GUIDELINES_MARKER",
      tools: "TOOLS_NOTES_MARKER",
    };
    const tools: ToolSummary[] = [
      { name: "tool_marker", description: "TOOL_DEF_MARKER" },
    ];

    const prompt = buildSystemPrompt(files, tools, defaultRuntime);

    const positions = {
      soul: prompt.indexOf("SOUL_MARKER"),
      identity: prompt.indexOf("IDENTITY_MARKER"),
      tools: prompt.indexOf("TOOL_DEF_MARKER"),
      runtime: prompt.indexOf("Current Time"),
      memory: prompt.indexOf("MEMORY_MARKER"),
      guidelines: prompt.indexOf("GUIDELINES_MARKER"),
    };

    expect(positions.soul).toBeLessThan(positions.identity);
    expect(positions.identity).toBeLessThan(positions.tools);
    expect(positions.tools).toBeLessThan(positions.runtime);
    expect(positions.runtime).toBeLessThan(positions.memory);
    expect(positions.memory).toBeLessThan(positions.guidelines);
  });

  it("sections are separated by double newlines", () => {
    const files = {
      ...emptyIdentity,
      soul: "Soul here",
      memory: "Memory here",
    };

    const prompt = buildSystemPrompt(files, [], defaultRuntime);

    // Sections should be separated by \n\n
    expect(prompt).toContain("Soul here\n\n## Current Time");
  });
});

// -----------------------------------------------------------------------------
// buildSystemPrompt - minimal and full prompts
// -----------------------------------------------------------------------------

describe("buildSystemPrompt - edge cases", () => {
  it("produces a minimal prompt with no identity files and no tools", () => {
    const prompt = buildSystemPrompt(emptyIdentity, [], defaultRuntime);

    // Should at least have the runtime section
    expect(prompt).toContain("## Current Time");
    expect(prompt).toContain("2026-02-05T14:30:00Z");
    // Should be relatively short
    expect(prompt.length).toBeLessThan(200);
  });

  it("produces a full prompt with all identity files and tools", () => {
    const files: IdentityFiles = {
      soul: "I am Komatachi, a curious and kind AI entity.",
      identity: "Name: Komatachi\nPronouns: they/them",
      user: "Linus is a software engineer who builds AI systems.",
      memory: "We discussed TypeScript patterns last week.",
      agents: "Be concise. Think step by step. No emojis.",
      tools: "Prefer read_file over cat. Use write_file for new files.",
    };
    const tools: ToolSummary[] = [
      { name: "read_file", description: "Read a file" },
      { name: "write_file", description: "Write a file" },
      { name: "bash", description: "Run a shell command" },
    ];
    const runtime = { currentTime: "2026-02-05T14:30:00Z" };

    const prompt = buildSystemPrompt(files, tools, runtime);

    // All sections present
    expect(prompt).toContain("I am Komatachi");
    expect(prompt).toContain("Name: Komatachi");
    expect(prompt).toContain("About the User");
    expect(prompt).toContain("Available Tools");
    expect(prompt).toContain("**read_file**");
    expect(prompt).toContain("**write_file**");
    expect(prompt).toContain("**bash**");
    expect(prompt).toContain("Current Time");
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("## Guidelines");
  });
});

// -----------------------------------------------------------------------------
// Integration: loadIdentityFiles -> buildSystemPrompt
// -----------------------------------------------------------------------------

describe("integration: load then build", () => {
  it("loads files and builds prompt end-to-end", () => {
    writeIdentityFile(
      "SOUL.md",
      "I am a persistent AI entity with memory and identity."
    );
    writeIdentityFile("IDENTITY.md", "Name: TestBot");
    writeIdentityFile("MEMORY.md", "User likes Rust.");

    const files = loadIdentityFiles(homeDir);
    const prompt = buildSystemPrompt(
      files,
      [{ name: "greet", description: "Say hello" }],
      { currentTime: "2026-01-01T00:00:00Z" }
    );

    expect(prompt).toContain("persistent AI entity");
    expect(prompt).toContain("Name: TestBot");
    expect(prompt).toContain("User likes Rust.");
    expect(prompt).toContain("**greet**: Say hello");
    expect(prompt).toContain("2026-01-01T00:00:00Z");
  });

  it("works with empty home directory", () => {
    const files = loadIdentityFiles(homeDir);
    const prompt = buildSystemPrompt(files, [], {
      currentTime: "2026-01-01T00:00:00Z",
    });

    // Should still produce a valid prompt (just the runtime section)
    expect(prompt).toContain("Current Time");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStorage,
  StorageNotFoundError,
  StorageCorruptionError,
  StorageIOError,
  type Storage,
} from "./index.js";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

let testDir: string;
let storage: Storage;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "komatachi-storage-test-"));
  storage = createStorage(testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// Write raw content to a file in the test directory (bypassing storage)
function writeRaw(path: string, content: string): void {
  writeFileSync(join(testDir, path), content, "utf-8");
}

// Read raw content from a file in the test directory (bypassing storage)
function readRaw(path: string): string {
  return readFileSync(join(testDir, path), "utf-8");
}

// -----------------------------------------------------------------------------
// JSON read/write
// -----------------------------------------------------------------------------

describe("readJson", () => {
  it("reads and parses a JSON file", () => {
    writeRaw("config.json", '{"name": "test", "version": 1}');

    const result = storage.readJson<{ name: string; version: number }>(
      "config.json"
    );

    expect(result).toEqual({ name: "test", version: 1 });
  });

  it("throws StorageNotFoundError for missing file", () => {
    expect(() => storage.readJson("missing.json")).toThrow(
      StorageNotFoundError
    );

    try {
      storage.readJson("missing.json");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageNotFoundError);
      expect((error as StorageNotFoundError).path).toBe("missing.json");
    }
  });

  it("throws StorageCorruptionError for invalid JSON", () => {
    writeRaw("bad.json", "not valid json {{{");

    expect(() => storage.readJson("bad.json")).toThrow(
      StorageCorruptionError
    );

    try {
      storage.readJson("bad.json");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageCorruptionError);
      expect((error as StorageCorruptionError).path).toBe("bad.json");
    }
  });

  it("reads files in subdirectories", () => {
    mkdirSync(join(testDir, "sub", "dir"), { recursive: true });
    writeRaw("sub/dir/data.json", '{"nested": true}');

    const result = storage.readJson<{ nested: boolean }>(
      "sub/dir/data.json"
    );

    expect(result).toEqual({ nested: true });
  });

  it("reads arrays", () => {
    writeRaw("list.json", "[1, 2, 3]");

    const result = storage.readJson<number[]>("list.json");

    expect(result).toEqual([1, 2, 3]);
  });

  it("reads null", () => {
    writeRaw("null.json", "null");

    const result = storage.readJson<null>("null.json");

    expect(result).toBeNull();
  });
});

describe("writeJson", () => {
  it("writes data as pretty-printed JSON", () => {
    storage.writeJson("out.json", { key: "value", count: 42 });

    const raw = readRaw("out.json");

    expect(raw).toBe('{\n  "key": "value",\n  "count": 42\n}\n');
  });

  it("creates parent directories automatically", () => {
    storage.writeJson("a/b/c/deep.json", { deep: true });

    const result = storage.readJson<{ deep: boolean }>(
      "a/b/c/deep.json"
    );

    expect(result).toEqual({ deep: true });
  });

  it("overwrites existing files", () => {
    storage.writeJson("data.json", { version: 1 });
    storage.writeJson("data.json", { version: 2 });

    const result = storage.readJson<{ version: number }>("data.json");

    expect(result).toEqual({ version: 2 });
  });

  it("round-trips complex objects", () => {
    const complex = {
      id: "abc-123",
      tags: ["a", "b"],
      nested: { deep: { value: true } },
      count: 0,
      items: [{ name: "first" }, { name: "second" }],
    };

    storage.writeJson("complex.json", complex);
    const result = storage.readJson<typeof complex>("complex.json");

    expect(result).toEqual(complex);
  });

  it("writes no temp files on success", () => {
    storage.writeJson("clean.json", { data: true });

    const files = readdirSync(testDir);

    expect(files).toEqual(["clean.json"]);
  });
});

// -----------------------------------------------------------------------------
// JSONL append and read
// -----------------------------------------------------------------------------

describe("appendJsonl", () => {
  it("creates the file and appends the first entry", () => {
    storage.appendJsonl("log.jsonl", { event: "start" });

    const raw = readRaw("log.jsonl");

    expect(raw).toBe('{"event":"start"}\n');
  });

  it("appends multiple entries as separate lines", () => {
    storage.appendJsonl("log.jsonl", { n: 1 });
    storage.appendJsonl("log.jsonl", { n: 2 });
    storage.appendJsonl("log.jsonl", { n: 3 });

    const raw = readRaw("log.jsonl");

    expect(raw).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
  });

  it("creates parent directories automatically", () => {
    storage.appendJsonl("deep/path/log.jsonl", { ok: true });

    const raw = readRaw("deep/path/log.jsonl");

    expect(raw).toBe('{"ok":true}\n');
  });
});

describe("readAllJsonl", () => {
  it("reads all entries from a JSONL file", () => {
    writeRaw("log.jsonl", '{"n":1}\n{"n":2}\n{"n":3}\n');

    const entries = storage.readAllJsonl<{ n: number }>("log.jsonl");

    expect(entries).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("returns empty array for an empty file", () => {
    writeRaw("empty.jsonl", "");

    const entries = storage.readAllJsonl("empty.jsonl");

    expect(entries).toEqual([]);
  });

  it("returns empty array for file with only whitespace", () => {
    writeRaw("whitespace.jsonl", "   \n  \n\n");

    const entries = storage.readAllJsonl("whitespace.jsonl");

    expect(entries).toEqual([]);
  });

  it("skips empty lines between entries", () => {
    writeRaw("sparse.jsonl", '{"a":1}\n\n{"b":2}\n\n');

    const entries = storage.readAllJsonl<{ a?: number; b?: number }>(
      "sparse.jsonl"
    );

    expect(entries).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("throws StorageNotFoundError for missing file", () => {
    expect(() => storage.readAllJsonl("missing.jsonl")).toThrow(
      StorageNotFoundError
    );
  });

  it("handles file with trailing newline", () => {
    writeRaw("trailing.jsonl", '{"x":1}\n');

    const entries = storage.readAllJsonl<{ x: number }>(
      "trailing.jsonl"
    );

    expect(entries).toEqual([{ x: 1 }]);
  });

  it("handles file without trailing newline", () => {
    writeRaw("no-trailing.jsonl", '{"x":1}');

    const entries = storage.readAllJsonl<{ x: number }>(
      "no-trailing.jsonl"
    );

    expect(entries).toEqual([{ x: 1 }]);
  });
});

describe("readAllJsonl - crash resilience", () => {
  it("skips partial trailing line from crash", () => {
    // Simulate crash mid-append: last line is incomplete JSON
    writeRaw("crashed.jsonl", '{"n":1}\n{"n":2}\n{"n":3');

    const entries = storage.readAllJsonl<{ n: number }>(
      "crashed.jsonl"
    );

    expect(entries).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("skips partial trailing line with only opening brace", () => {
    writeRaw("partial.jsonl", '{"n":1}\n{');

    const entries = storage.readAllJsonl<{ n: number }>(
      "partial.jsonl"
    );

    expect(entries).toEqual([{ n: 1 }]);
  });

  it("returns empty array when only entry is partial", () => {
    writeRaw("only-partial.jsonl", '{"incomplete');

    const entries = storage.readAllJsonl("only-partial.jsonl");

    expect(entries).toEqual([]);
  });

  it("throws StorageCorruptionError for corrupt non-trailing line", () => {
    // Corruption in the middle -- this is not a crash artifact
    writeRaw(
      "corrupt-middle.jsonl",
      '{"n":1}\nNOT_JSON\n{"n":3}\n'
    );

    expect(() =>
      storage.readAllJsonl("corrupt-middle.jsonl")
    ).toThrow(StorageCorruptionError);
  });

  it("throws StorageCorruptionError for corrupt first line with valid later lines", () => {
    writeRaw("corrupt-first.jsonl", 'CORRUPT\n{"n":2}\n');

    expect(() =>
      storage.readAllJsonl("corrupt-first.jsonl")
    ).toThrow(StorageCorruptionError);
  });
});

describe("readRangeJsonl", () => {
  it("reads a range of entries [start, end)", () => {
    writeRaw(
      "range.jsonl",
      '{"n":0}\n{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n'
    );

    const entries = storage.readRangeJsonl<{ n: number }>(
      "range.jsonl",
      1,
      3
    );

    expect(entries).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("returns empty array when start >= end", () => {
    writeRaw("range.jsonl", '{"n":0}\n{"n":1}\n');

    const entries = storage.readRangeJsonl("range.jsonl", 3, 1);

    expect(entries).toEqual([]);
  });

  it("clamps to available entries when end exceeds file length", () => {
    writeRaw("short.jsonl", '{"n":0}\n{"n":1}\n');

    const entries = storage.readRangeJsonl<{ n: number }>(
      "short.jsonl",
      0,
      100
    );

    expect(entries).toEqual([{ n: 0 }, { n: 1 }]);
  });

  it("returns empty array when start exceeds file length", () => {
    writeRaw("short.jsonl", '{"n":0}\n');

    const entries = storage.readRangeJsonl("short.jsonl", 10, 20);

    expect(entries).toEqual([]);
  });

  it("reads from start=0 to end", () => {
    writeRaw("range.jsonl", '{"n":0}\n{"n":1}\n{"n":2}\n');

    const entries = storage.readRangeJsonl<{ n: number }>(
      "range.jsonl",
      0,
      2
    );

    expect(entries).toEqual([{ n: 0 }, { n: 1 }]);
  });
});

describe("writeJsonl", () => {
  it("writes entries as JSONL", () => {
    storage.writeJsonl("out.jsonl", [{ a: 1 }, { b: 2 }, { c: 3 }]);

    const raw = readRaw("out.jsonl");

    expect(raw).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
  });

  it("writes empty file for empty array", () => {
    storage.writeJsonl("empty.jsonl", []);

    const raw = readRaw("empty.jsonl");

    expect(raw).toBe("");
  });

  it("overwrites existing JSONL file atomically", () => {
    storage.appendJsonl("log.jsonl", { old: 1 });
    storage.appendJsonl("log.jsonl", { old: 2 });

    storage.writeJsonl("log.jsonl", [{ new: 1 }]);

    const entries = storage.readAllJsonl<{ new?: number }>(
      "log.jsonl"
    );

    expect(entries).toEqual([{ new: 1 }]);
  });

  it("creates parent directories automatically", () => {
    storage.writeJsonl("x/y/z.jsonl", [{ nested: true }]);

    const entries = storage.readAllJsonl<{ nested: boolean }>(
      "x/y/z.jsonl"
    );

    expect(entries).toEqual([{ nested: true }]);
  });
});

// -----------------------------------------------------------------------------
// Round-trip and integration
// -----------------------------------------------------------------------------

describe("round-trip", () => {
  it("append then readAll preserves order and content", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    for (const msg of messages) {
      storage.appendJsonl("transcript.jsonl", msg);
    }

    const loaded = storage.readAllJsonl<{
      role: string;
      content: string;
    }>("transcript.jsonl");

    expect(loaded).toEqual(messages);
  });

  it("writeJsonl then readAllJsonl round-trips correctly", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      data: `entry-${i}`,
    }));

    storage.writeJsonl("large.jsonl", entries);
    const loaded = storage.readAllJsonl<{
      index: number;
      data: string;
    }>("large.jsonl");

    expect(loaded).toEqual(entries);
  });

  it("writeJson then readJson round-trips correctly", () => {
    const data = {
      timestamps: { created: 1000, updated: 2000 },
      compactionCount: 3,
      model: "claude-sonnet-4-20250514",
    };

    storage.writeJson("meta.json", data);
    const loaded = storage.readJson<typeof data>("meta.json");

    expect(loaded).toEqual(data);
  });
});

// -----------------------------------------------------------------------------
// Base directory and path resolution
// -----------------------------------------------------------------------------

describe("baseDir", () => {
  it("exposes the base directory", () => {
    expect(storage.baseDir).toBe(testDir);
  });

  it("resolves paths relative to baseDir", () => {
    storage.writeJson("sub/file.json", { ok: true });

    const raw = readRaw("sub/file.json");
    expect(raw).toContain('"ok": true');
  });
});

// -----------------------------------------------------------------------------
// Error type properties
// -----------------------------------------------------------------------------

describe("error types", () => {
  it("StorageNotFoundError has correct name and path", () => {
    const error = new StorageNotFoundError("some/path.json");
    expect(error.name).toBe("StorageNotFoundError");
    expect(error.path).toBe("some/path.json");
    expect(error.message).toContain("some/path.json");
    expect(error).toBeInstanceOf(Error);
  });

  it("StorageCorruptionError has correct name, path, and cause", () => {
    const cause = new SyntaxError("Unexpected token");
    const error = new StorageCorruptionError("data.json", cause);
    expect(error.name).toBe("StorageCorruptionError");
    expect(error.path).toBe("data.json");
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it("StorageIOError has correct name, path, and cause", () => {
    const cause = new Error("EACCES");
    const error = new StorageIOError("locked.json", cause);
    expect(error.name).toBe("StorageIOError");
    expect(error.path).toBe("locked.json");
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });
});

// -----------------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles JSON with unicode characters", () => {
    const data = { text: "Hello \u{1F600} World", kanji: "\u6771\u4EAC" };
    storage.writeJson("unicode.json", data);
    const loaded = storage.readJson<typeof data>("unicode.json");
    expect(loaded).toEqual(data);
  });

  it("handles JSONL with unicode characters", () => {
    const entry = { text: "caf\u00e9 \u2603" };
    storage.appendJsonl("unicode.jsonl", entry);
    const loaded = storage.readAllJsonl<typeof entry>("unicode.jsonl");
    expect(loaded).toEqual([entry]);
  });

  it("handles JSONL entries with embedded newlines in strings", () => {
    // JSON.stringify escapes newlines in strings, so they don't break JSONL
    const entry = { text: "line1\nline2\nline3" };
    storage.appendJsonl("newlines.jsonl", entry);
    const loaded = storage.readAllJsonl<typeof entry>("newlines.jsonl");
    expect(loaded).toEqual([entry]);
  });

  it("handles writeJsonl with single entry", () => {
    storage.writeJsonl("single.jsonl", [{ only: true }]);
    const loaded = storage.readAllJsonl<{ only: boolean }>(
      "single.jsonl"
    );
    expect(loaded).toEqual([{ only: true }]);
  });

  it("handles very long JSON values", () => {
    const longString = "x".repeat(100_000);
    storage.writeJson("long.json", { data: longString });
    const loaded = storage.readJson<{ data: string }>("long.json");
    expect(loaded.data.length).toBe(100_000);
  });

  it("handles deeply nested objects", () => {
    // Build a deeply nested object (100 levels)
    let obj: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100; i++) {
      obj = { nested: obj };
    }
    storage.writeJson("deep.json", obj);
    const loaded = storage.readJson<typeof obj>("deep.json");
    expect(loaded).toEqual(obj);
  });
});

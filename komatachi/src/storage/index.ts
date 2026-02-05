/**
 * Storage Module
 *
 * Generic file-based persistence primitives. JSON read/write with atomic
 * operations. JSONL append-only logs. No domain knowledge (sessions,
 * messages, metadata schemas).
 *
 * Design principles:
 * - Respect layer boundaries: Storage stores; it does not interpret
 * - Fail clearly: Specific error types for not-found, corruption, I/O
 * - Make state explicit: No caching, no hidden state
 * - Crash resilient: Atomic writes (write-to-temp, rename), partial line handling
 * - Synchronous I/O: Single-digit ms disk writes, dominated by LLM API latency
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Generic file-based storage.
 *
 * All paths are relative to the base directory. Supports two formats:
 * - JSON: Single-document read/write with atomic operations
 * - JSONL: Append-only log with line-by-line entries
 */
export interface Storage {
  /** The base directory for all storage operations */
  readonly baseDir: string;

  /** Read and parse a JSON file */
  readJson<T>(path: string): T;

  /** Write data as JSON with atomic write (write-to-temp, rename) */
  writeJson<T>(path: string, data: T): void;

  /** Append a single JSON entry as a new line to a JSONL file */
  appendJsonl<T>(path: string, entry: T): void;

  /** Read all entries from a JSONL file. Skips partial trailing lines from crashes */
  readAllJsonl<T>(path: string): T[];

  /** Read entries from a JSONL file in line range [start, end) */
  readRangeJsonl<T>(path: string, start: number, end: number): T[];

  /** Atomically rewrite a JSONL file with new entries */
  writeJsonl<T>(path: string, entries: T[]): void;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * File or path not found.
 */
export class StorageNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Not found: ${path}`);
    this.name = "StorageNotFoundError";
  }
}

/**
 * File exists but contents are corrupt (invalid JSON, etc.).
 */
export class StorageCorruptionError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause?: unknown
  ) {
    super(`Corrupt data in: ${path}`);
    this.name = "StorageCorruptionError";
  }
}

/**
 * Filesystem I/O failure (permissions, disk full, etc.).
 */
export class StorageIOError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause?: unknown
  ) {
    super(`I/O error on: ${path}`);
    this.name = "StorageIOError";
  }
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

/**
 * Create a storage instance rooted at the given base directory.
 *
 * All paths passed to methods are resolved relative to baseDir.
 * Parent directories are created automatically on write operations.
 */
export function createStorage(baseDir: string): Storage {
  function resolve(relativePath: string): string {
    return join(baseDir, relativePath);
  }

  function ensureParentDir(fullPath: string): void {
    mkdirSync(dirname(fullPath), { recursive: true });
  }

  /**
   * Atomic write: write to a temp file in the same directory, then rename.
   * Rename is atomic on POSIX filesystems, providing crash safety.
   */
  function atomicWrite(fullPath: string, content: string): void {
    ensureParentDir(fullPath);
    const tempPath = `${fullPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, content, "utf-8");
      renameSync(tempPath, fullPath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Temp file cleanup is best-effort
      }
      throw error;
    }
  }

  /**
   * Parse JSONL content into entries.
   *
   * Skips empty lines. Handles partial trailing lines from crashes:
   * if the last non-empty line fails to parse, it is silently skipped.
   * Corrupt non-trailing lines throw StorageCorruptionError.
   */
  function parseJsonlContent<T>(content: string, path: string): T[] {
    const lines = content.split("\n");
    const entries: T[] = [];

    // Find the index of the last non-empty line for partial-line detection
    let lastNonEmptyIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== "") {
        lastNonEmptyIndex = i;
        break;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "") continue;

      try {
        entries.push(JSON.parse(line) as T);
      } catch (parseError) {
        if (i === lastNonEmptyIndex) {
          // Partial trailing line from crash -- skip silently
          continue;
        }
        throw new StorageCorruptionError(path, parseError);
      }
    }

    return entries;
  }

  // -- Method implementations as closures (no `this` binding issues) ----------

  function readJson<T>(path: string): T {
    const fullPath = resolve(path);

    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new StorageNotFoundError(path);
      }
      throw new StorageIOError(path, error);
    }

    try {
      return JSON.parse(content) as T;
    } catch (parseError) {
      throw new StorageCorruptionError(path, parseError);
    }
  }

  function writeJson<T>(path: string, data: T): void {
    const fullPath = resolve(path);
    try {
      atomicWrite(fullPath, JSON.stringify(data, null, 2) + "\n");
    } catch (error) {
      throw new StorageIOError(path, error);
    }
  }

  function appendJsonl<T>(path: string, entry: T): void {
    const fullPath = resolve(path);
    try {
      ensureParentDir(fullPath);
      appendFileSync(fullPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (error) {
      throw new StorageIOError(path, error);
    }
  }

  function readAllJsonl<T>(path: string): T[] {
    const fullPath = resolve(path);

    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new StorageNotFoundError(path);
      }
      throw new StorageIOError(path, error);
    }

    return parseJsonlContent<T>(content, path);
  }

  function readRangeJsonl<T>(
    path: string,
    start: number,
    end: number
  ): T[] {
    const all = readAllJsonl<T>(path);
    return all.slice(start, end);
  }

  function writeJsonl<T>(
    path: string,
    entries: T[]
  ): void {
    const fullPath = resolve(path);
    const content =
      entries.length === 0
        ? ""
        : entries.map((entry) => JSON.stringify(entry) + "\n").join("");
    try {
      atomicWrite(fullPath, content);
    } catch (error) {
      throw new StorageIOError(path, error);
    }
  }

  return {
    baseDir,
    readJson,
    writeJson,
    appendJsonl,
    readAllJsonl,
    readRangeJsonl,
    writeJsonl,
  };
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

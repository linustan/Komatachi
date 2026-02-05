import { describe, it, expect } from "vitest";
import {
  exportForApi,
  findTool,
  executeTool,
  type ToolDefinition,
  type ToolResult,
} from "./index.js";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

function createTool(
  name: string,
  handler?: (input: unknown) => Promise<ToolResult>
): ToolDefinition {
  return {
    name,
    description: `${name} tool description`,
    inputSchema: {
      type: "object" as const,
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
    },
    handler: handler ?? (async () => ({ ok: true as const, content: "done" })),
  };
}

// -----------------------------------------------------------------------------
// exportForApi
// -----------------------------------------------------------------------------

describe("exportForApi", () => {
  it("strips handler and maps to API format", () => {
    const tools = [createTool("get_time"), createTool("read_file")];

    const apiTools = exportForApi(tools);

    expect(apiTools).toHaveLength(2);
    expect(apiTools[0]).toEqual({
      name: "get_time",
      description: "get_time tool description",
      input_schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    });
    // handler should not be present
    expect("handler" in apiTools[0]).toBe(false);
  });

  it("returns empty array for no tools", () => {
    expect(exportForApi([])).toEqual([]);
  });

  it("preserves input schema structure", () => {
    const tool: ToolDefinition = {
      name: "complex_tool",
      description: "A tool with complex schema",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "Content to write" },
          overwrite: { type: "boolean", default: false },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      handler: async () => ({ ok: true, content: "ok" }),
    };

    const apiTools = exportForApi([tool]);

    expect(apiTools[0].input_schema).toEqual(tool.inputSchema);
  });

  it("uses input_schema (snake_case) for API format", () => {
    const tools = [createTool("test")];

    const apiTools = exportForApi(tools);

    // API uses snake_case: input_schema
    expect(apiTools[0]).toHaveProperty("input_schema");
    // Our internal type uses camelCase: inputSchema
    // But the export maps it correctly
    expect(apiTools[0].input_schema).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// findTool
// -----------------------------------------------------------------------------

describe("findTool", () => {
  it("finds a tool by name", () => {
    const tools = [
      createTool("get_time"),
      createTool("read_file"),
      createTool("bash"),
    ];

    const found = findTool(tools, "read_file");

    expect(found).toBeDefined();
    expect(found!.name).toBe("read_file");
  });

  it("returns undefined for unknown tool", () => {
    const tools = [createTool("get_time")];

    expect(findTool(tools, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for empty tool list", () => {
    expect(findTool([], "any")).toBeUndefined();
  });

  it("finds first tool when duplicates exist", () => {
    const first = createTool("dup");
    const second = createTool("dup");
    const tools = [first, second];

    expect(findTool(tools, "dup")).toBe(first);
  });

  it("is case-sensitive", () => {
    const tools = [createTool("Read_File")];

    expect(findTool(tools, "read_file")).toBeUndefined();
    expect(findTool(tools, "Read_File")).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// executeTool
// -----------------------------------------------------------------------------

describe("executeTool", () => {
  it("returns success result from handler", async () => {
    const tool = createTool(
      "test",
      async () => ({ ok: true, content: "hello world" })
    );

    const result = await executeTool(tool, {});

    expect(result).toEqual({ ok: true, content: "hello world" });
  });

  it("returns error result from handler", async () => {
    const tool = createTool(
      "test",
      async () => ({ ok: false, error: "something went wrong" })
    );

    const result = await executeTool(tool, {});

    expect(result).toEqual({ ok: false, error: "something went wrong" });
  });

  it("catches thrown errors and wraps as error result", async () => {
    const tool = createTool("test", async () => {
      throw new Error("unexpected failure");
    });

    const result = await executeTool(tool, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unexpected failure");
    }
  });

  it("catches non-Error throws", async () => {
    const tool = createTool("test", async () => {
      throw "string error";
    });

    const result = await executeTool(tool, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("string error");
    }
  });

  it("passes input to handler", async () => {
    let receivedInput: unknown;
    const tool = createTool("test", async (input) => {
      receivedInput = input;
      return { ok: true, content: "received" };
    });

    await executeTool(tool, { path: "/tmp/test.txt" });

    expect(receivedInput).toEqual({ path: "/tmp/test.txt" });
  });

  it("handles async handler that takes time", async () => {
    const tool = createTool("test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, content: "delayed result" };
    });

    const result = await executeTool(tool, {});

    expect(result).toEqual({ ok: true, content: "delayed result" });
  });
});

// -----------------------------------------------------------------------------
// ToolResult type
// -----------------------------------------------------------------------------

describe("ToolResult type", () => {
  it("success result has ok:true and content", () => {
    const result: ToolResult = { ok: true, content: "success" };
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("success");
    }
  });

  it("error result has ok:false and error", () => {
    const result: ToolResult = { ok: false, error: "failed" };
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("failed");
    }
  });
});

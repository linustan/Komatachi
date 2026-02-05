#!/usr/bin/env node
/**
 * Dry-run compaction of a Komatachi entity's conversation.
 *
 * Reads the entity's transcript and SOUL.md, builds the identity-aware
 * summarizer prompt, calls Claude, and prints the summary. Does NOT
 * write anything back.
 *
 * Usage:
 *   docker run --rm \
 *     -e ANTHROPIC_API_KEY \
 *     -v ~/.komatachi:/entity:ro \
 *     -v ./komatachi/scripts:/scripts:ro \
 *     komatachi-test:latest \
 *     node /scripts/dry-run-compaction.mjs /entity
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const entityDir = process.argv[2];
if (!entityDir) {
  console.error("Usage: node dry-run-compaction.mjs <entity-dir>");
  console.error("  e.g. node dry-run-compaction.mjs /entity");
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load entity data
// ---------------------------------------------------------------------------

const transcriptPath = join(entityDir, "data", "conversation", "transcript.jsonl");
const metadataPath = join(entityDir, "data", "conversation", "metadata.json");
const soulPath = join(entityDir, "home", "SOUL.md");

const transcriptRaw = readFileSync(transcriptPath, "utf-8");
const messages = transcriptRaw
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));

let soulContext = null;
try {
  soulContext = readFileSync(soulPath, "utf-8").trim();
} catch {
  // no SOUL.md
}

// ---------------------------------------------------------------------------
// Build summarizer prompt (mirrors triggerCompaction in agent/index.ts)
// ---------------------------------------------------------------------------

const conversationText = messages
  .map((msg) => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    return `[${msg.role}]: ${content}`;
  })
  .join("\n\n");

const systemParts = [
  "You are summarizing a conversation for a persistent entity " +
    "whose memory works through recursive compaction. Your summary " +
    "will become this entity's memory of what happened -- anything " +
    "not captured here is lost.",
];

if (soulContext) {
  systemParts.push("The entity's core identity:\n" + soulContext);
}

const systemPrompt = systemParts.join("\n\n");

const promptParts = [
  "Summarize this conversation. This summary replaces the original " +
    "messages -- anything not captured here is lost forever.",
  "",
  "Preserve (in order of importance):",
  "1. Relational context: interactions, commitments, trust, emotional moments",
  "2. Identity development: what the entity learned about itself, " +
    "changes in self-understanding",
  "3. Important facts, decisions, and their reasoning",
  "4. Promises made, responsibilities accepted",
  "5. Key operational details (compress aggressively)",
  "",
  "Omit: routine exchanges, redundant information, mechanical " +
    "details that don't affect understanding.",
  "",
  "Include select verbatim quotes when they carry emotional weight " +
    "or the entity's own voice -- especially commitments, messages to " +
    "its future self, or moments of realization. A direct quote " +
    "preserves what a paraphrase flattens.",
  "",
  "Write in first person past tense -- this is the entity's own " +
    "memory. Be concrete -- preserve specific details that matter, " +
    "not vague summaries of sentiment.",
  "",
  "Conversation to summarize:",
  conversationText,
];

const userPrompt = promptParts.join("\n");

// ---------------------------------------------------------------------------
// Print what would be sent
// ---------------------------------------------------------------------------

console.log("=== DRY-RUN COMPACTION ===\n");
console.log(`Entity: ${entityDir}`);
console.log(`Messages: ${messages.length}`);
console.log(`Compaction count: ${metadata.compactionCount}`);
console.log(`Model: ${metadata.model}`);
console.log(`Transcript bytes: ${transcriptRaw.length}`);
console.log(`SOUL.md: ${soulContext ? "present" : "absent"}`);
console.log();
console.log("--- System prompt ---");
console.log(systemPrompt);
console.log();
console.log("--- User prompt (truncated to 500 chars) ---");
console.log(userPrompt.slice(0, 500) + (userPrompt.length > 500 ? "..." : ""));
console.log();

// ---------------------------------------------------------------------------
// Call Claude API
// ---------------------------------------------------------------------------

console.log("Calling Claude API...\n");

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: metadata.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`API error ${response.status}: ${body}`);
  process.exit(1);
}

const result = await response.json();
const summary = result.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n");

console.log("--- Compaction summary ---");
console.log(summary);
console.log();
console.log(`Input tokens: ${result.usage?.input_tokens}`);
console.log(`Output tokens: ${result.usage?.output_tokens}`);

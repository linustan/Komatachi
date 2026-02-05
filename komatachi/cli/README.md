# Komatachi CLI

Interactive terminal for talking to a Komatachi agent. The agent runs inside a Docker container; the CLI handles user I/O and manages the container lifecycle.

## Prerequisites

- [Rust](https://rustup.rs/) (for building the CLI)
- [Docker](https://docs.docker.com/get-docker/) (for running the agent)
- An [Anthropic API key](https://console.anthropic.com/)

## Quick start

```sh
cd komatachi/cli
ANTHROPIC_API_KEY=sk-ant-... cargo run
```

On first run, the CLI builds the Docker image (cached afterward). Once ready:

```
Building Docker image... done.
Komatachi ready. Type 'quit' or 'exit' to stop.

> Hello
Hi! How can I help you today?
> exit
```

Conversation persists across runs. Start the CLI again and the agent remembers prior turns.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `KOMATACHI_DATA_DIR` | `~/.komatachi/data` | Conversation storage on the host |
| `KOMATACHI_HOME_DIR` | `~/.komatachi/home` | Agent identity files on the host |
| `KOMATACHI_MODEL` | `claude-sonnet-4-20250514` | Claude model to use |
| `KOMATACHI_MAX_TOKENS` | `4096` | Maximum tokens per response |
| `KOMATACHI_CONTEXT_WINDOW` | `200000` | Context window size in tokens |

## Agent identity

The agent reads identity files from the home directory (`~/.komatachi/home/` by default). These are plain markdown files you create and edit:

| File | Purpose |
|------|---------|
| `SOUL.md` | Core identity -- who the agent is |
| `IDENTITY.md` | Name, personality, voice |
| `USER.md` | Information about the user |
| `MEMORY.md` | Long-term notes and memories |
| `AGENTS.md` | Knowledge of other agents |
| `TOOLS.md` | Tool usage guidelines |

All files are optional. The agent starts minimal and incorporates whatever files exist. Edit them between conversations and the agent picks up changes on the next turn.

## How it works

```
Host                                    Docker container
┌──────────────┐   JSON-lines stdin    ┌────────────────────┐
│              │ ───────────────────>  │                    │
│  Rust CLI    │                       │  node dist/index.js│
│  (terminal)  │   JSON-lines stdout   │                    │
│              │ <───────────────────  │  (agent loop,      │
└──────────────┘                       │   Claude API,      │
       │                               │   conversation     │
       │ docker run -i --rm            │   persistence)     │
       │   -e ANTHROPIC_API_KEY=...    └────────────────────┘
       │   -v data:/data                     │        │
       │   -v home:/home/agent               │        │
       │                                     ▼        ▼
       │                                  /data    /home/agent
       │                                     │        │
       └── volume mounts ───────────────────-┘        │
           ~/.komatachi/data ────────────────-────────-┘
           ~/.komatachi/home ────────────────-─────────┘
```

### Startup sequence

1. The CLI reads `ANTHROPIC_API_KEY` from the environment and validates it exists.
2. It creates `~/.komatachi/data/` and `~/.komatachi/home/` if they don't exist.
3. It runs `docker compose build app` (from `komatachi/docker-compose.yml`) to build or cache the image.
4. It spawns `docker run -i --rm` with:
   - The API key and any `KOMATACHI_*` env vars passed through via `-e`
   - `~/.komatachi/data` mounted at `/data` inside the container (conversation storage)
   - `~/.komatachi/home` mounted at `/home/agent` inside the container (identity files)
5. The TypeScript entry point (`dist/index.js`) starts inside the container, creates the agent, and writes `{"type":"ready"}` to stdout.
6. The CLI reads the ready signal and starts the REPL.

### Message exchange

Each turn is one JSON line in each direction:

```
CLI  -> Agent:  {"type":"input","text":"Hello, how are you?"}
Agent -> CLI:   {"type":"output","text":"I'm doing well! How can I help?"}
```

On errors:

```
Agent -> CLI:   {"type":"error","message":"Model call failed: rate limited"}
```

### What lives where

**On the host** (persists across container restarts):
- `~/.komatachi/data/conversation/metadata.json` -- conversation metadata (timestamps, compaction count)
- `~/.komatachi/data/conversation/transcript.jsonl` -- full message history (append-only, compacted when context overflows)
- `~/.komatachi/home/*.md` -- identity files you create and edit

**Inside the container** (ephemeral, `--rm` deletes on exit):
- `/app/dist/` -- compiled TypeScript
- `/app/node_modules/` -- npm dependencies (including `@anthropic-ai/sdk`)
- The Node.js process and all API calls

The container never touches the host filesystem directly. The only bridge is the two volume mounts and the stdin/stdout pipe.

### Conversation lifecycle

- First run: the agent creates a new conversation (empty transcript + metadata).
- Subsequent runs: the agent loads the existing conversation from disk and continues.
- When the context window fills up, the agent compacts older messages into a summary and continues.
- To start fresh: delete `~/.komatachi/data/` (or the specific `KOMATACHI_DATA_DIR`).

## Building a release binary

```sh
cd komatachi/cli
cargo build --release
# Binary at: target/release/komatachi-cli
```

The binary embeds the path to `komatachi/` (via `CARGO_MANIFEST_DIR`) so it can find the `docker-compose.yml` for building the image. Run it from anywhere as long as the `komatachi/` directory hasn't moved since compilation.

# Runtime Model Scouting Report

## Summary

OpenClaw runs as a **persistent daemon process** (the "Gateway") that handles all messaging, session management, and agent execution. Clients (CLI, web UI, mobile apps, nodes) communicate with the Gateway over WebSocket. This is the critical architectural pattern that enables always-on messaging while allowing multiple clients to connect and control the system.

This report documents what was NOT captured in our previous scouting reports: the process architecture, daemon lifecycle, and client-server communication model.

## The Gateway Daemon

### What It Is

The Gateway is a long-running Node.js process that:
- **Owns all messaging connections** (WhatsApp via Baileys, Telegram via grammY, Discord, Slack, Signal, iMessage, WebChat)
- **Exposes a WebSocket API** on a configurable port (default 18789)
- **Runs agents in-process** via `runEmbeddedPiAgent()` - agents are NOT separate processes
- **Manages all session state** (file-based JSON stores for sessions, JSONL for transcripts)
- **Handles tool execution** (exec, browser, etc.) directly in-process
- **Emits events** to connected clients (agent output, presence, health, tick)

### Process Lifecycle

```
                    ┌─────────────────────────────────────────┐
                    │           Service Manager               │
                    │  (launchd on macOS, systemd on Linux)   │
                    └─────────────────┬───────────────────────┘
                                      │ starts/restarts
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Gateway Process                              │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  │   Slack     │ │
│  │ (Baileys)   │  │  (grammY)   │  │  (discord.js)│ │  (Bolt)     │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │        │
│         └────────────────┴────────────────┴────────────────┘        │
│                                  │                                   │
│                                  ▼                                   │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Message Router                            │  │
│  │  (channel → agent binding → session key resolution)           │  │
│  └───────────────────────────────────┬───────────────────────────┘  │
│                                      │                               │
│                                      ▼                               │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                   Embedded Agent Runner                       │  │
│  │  (runEmbeddedPiAgent: session manager, tools, LLM calls)      │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    WebSocket Server                           │  │
│  │  (control plane API for CLI, web UI, nodes)                   │  │
│  │  Port 18789 (configurable)                                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Service Management

The Gateway is designed to run under a service manager:

**macOS (launchd)**:
- Installed via `openclaw gateway install`
- Service file: `~/Library/LaunchAgents/bot.molt.gateway.plist`
- Managed with `launchctl`
- Requires logged-in user session (LaunchAgent, not LaunchDaemon)

**Linux (systemd)**:
- User service: `~/.config/systemd/user/openclaw-gateway.service`
- System service: `/etc/systemd/system/openclaw-gateway.service`
- Requires `loginctl enable-linger` for user services
- Managed with `systemctl --user` or `systemctl`

### Hot Reload and Restart

- Config changes can trigger hot reload via SIGUSR1
- Service managers auto-restart on crash
- Graceful shutdown emits `shutdown` event to clients before closing

## Client-Server Communication

### Protocol

All clients communicate via WebSocket using a JSON-based RPC protocol:

```
Client                        Gateway
   │                             │
   │──── req:connect ───────────▶│  (mandatory first frame)
   │◀─── res:hello-ok ───────────│  (includes snapshot: health, presence)
   │                             │
   │──── req:agent ─────────────▶│  (trigger agent run)
   │◀─── res:accepted ───────────│  (ack with runId)
   │◀─── event:agent ────────────│  (streaming output)
   │◀─── event:agent ────────────│  (streaming output)
   │◀─── res:final ──────────────│  (run complete)
   │                             │
   │◀─── event:tick ─────────────│  (periodic keepalive)
   │◀─── event:presence ─────────│  (presence updates)
   │                             │
```

### Client Types

1. **CLI (`openclaw`)** - Thin client for operators
   - `openclaw gateway health` - Query health
   - `openclaw agent --message "..."` - Trigger agent run
   - `openclaw message send` - Send messages
   - `openclaw logs --follow` - Tail logs

2. **Web UI (Control UI)** - Browser-based admin
   - Same WebSocket API
   - Renders forms from schema
   - Real-time updates via events

3. **macOS/iOS App** - Native clients
   - WebChat interface
   - Presence display
   - Remote access via SSH tunnel

4. **Nodes** - Capability providers
   - Mobile devices with camera/screen/location
   - Connect with `role: "node"` in handshake
   - Expose commands (`camera.snap`, `screen.record`, etc.)

### Authentication

- Token-based: `OPENCLAW_GATEWAY_TOKEN` or config `gateway.auth.token`
- Device pairing: New devices require approval
- Local connections can be auto-approved

## Key Architectural Insights

### 1. Agents Are Embedded, Not Separate

**Critical insight**: Agents run IN-PROCESS via `runEmbeddedPiAgent()`. There is no agent subprocess or separate agent process. The Gateway IS the agent runtime.

This means:
- All agent state is in Gateway memory
- Tool execution happens in the Gateway process
- Session file I/O is direct (no IPC)
- Crash in agent code crashes the Gateway

### 2. Single Gateway Per Host

By design, one Gateway owns one set of messaging credentials per host. Multiple Gateways require:
- Isolated ports
- Isolated state directories
- Isolated credentials

### 3. CLI Is Stateless

The CLI (`openclaw`) is a thin client that:
- Connects to Gateway via WebSocket
- Sends RPC requests
- Displays responses/events
- Holds no persistent state itself

### 4. State Is File-Based

All persistent state lives on the Gateway's filesystem:
- Sessions: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcripts: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- Auth: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Config: `~/.openclaw/openclaw.json`
- Credentials: `~/.openclaw/credentials/`

### 5. Multi-Agent Is Multi-Config

Multiple agents share one Gateway process but have:
- Separate workspaces
- Separate session stores
- Separate auth profiles
- Routing via "bindings" in config

## Source Files

### Gateway Core
| File | Lines | Description |
|------|-------|-------------|
| `src/gateway/server.ts` | ~800 | Main Gateway server |
| `src/gateway/protocol/schema.ts` | ~400 | Protocol type definitions |
| `src/gateway/server-methods/*.ts` | ~2000 | RPC method handlers |
| `src/gateway/ws-log.ts` | ~200 | WebSocket logging |

### Service Management
| File | Lines | Description |
|------|-------|-------------|
| `src/cli/daemon-cli/install.ts` | ~400 | Service installation |
| `src/cli/daemon-cli/status.gather.ts` | ~300 | Status gathering |
| `src/cli/gateway-cli/run.ts` | ~500 | Gateway run command |

### Embedded Agent Runner
| File | Lines | Description |
|------|-------|-------------|
| `src/agents/pi-embedded-runner/run.ts` | ~600 | Main agent runner |
| `src/agents/pi-embedded-runner/run/attempt.ts` | ~400 | Single run attempt |
| `src/agents/pi-embedded-runner/compact.ts` | ~300 | Context compaction |

### Documentation
| File | Description |
|------|-------------|
| `docs/gateway/index.md` | Gateway runbook |
| `docs/gateway/protocol.md` | Protocol specification |
| `docs/concepts/architecture.md` | Architecture overview |
| `docs/concepts/multi-agent.md` | Multi-agent routing |

## Complexity Assessment: MEDIUM-HIGH

### Reasoning:

1. **Clean separation of concerns** - Gateway, Protocol, Clients are well-separated
2. **Well-documented protocol** - TypeBox schemas, JSON Schema generation
3. **Complexity in multi-agent routing** - Bindings, channel accounts, peer matching
4. **Service management cross-platform** - launchd, systemd, (WSL)
5. **Embedded agent model** - Simpler than subprocess IPC, but couples crash domains

## Implications for Komatachi

### What We Should Preserve

1. **Daemon + CLI separation** - Clean boundary between persistent state and operator interface
2. **WebSocket-based protocol** - Enables remote operation, multiple clients, real-time events
3. **Service manager integration** - Reliable restart, log rotation, boot startup
4. **File-based state** - Simple, debuggable, portable

### What We Could Simplify

1. **Single-agent focus** - Skip multi-agent routing for MVP
2. **Fewer client types** - CLI only initially, add web UI later
3. **Simplified protocol** - We don't need all of OpenClaw's methods
4. **No multi-channel** - Start with direct LLM interaction, not messaging platforms

### Critical Design Decision

**If CLI and daemon may be on different machines**, we must:
1. Design the protocol for network latency and disconnection
2. Include authentication from day one
3. Keep state entirely on the daemon side
4. Make CLI operations idempotent and stateless

**Recommendation**: Even for MVP, implement the daemon/CLI split. Start them on the same machine, but communicate via localhost WebSocket (or Unix socket). This ensures:
- Architecture supports remote operation from day one
- No hidden coupling via shared memory/filesystem access
- Clean boundary for testing (mock daemon, mock CLI)

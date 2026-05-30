# Serena Integration Plan and Tradeoffs

## Current Pourkit Architecture Context

### Sandbox Lifecycle

Pourkit creates one Sandcastle Docker container per Issue run session,
reused across Builder/Reviewer/Refactor stages. The Sandbox wraps a Worktree
(git worktree on host) where agent roles execute.

Key files:
- `.sandcastle/Dockerfile` — base Node 22 image with OpenCode + RTK
- `.pourkit/sandbox.ts` — SandboxConfig: mounts OpenCode data/config,
  sets env vars, docker provider
- `pourkit/execution/sandcastle-execution.ts` — creates worktree, sandbox,
  runs agent
- `pourkit/execution/sandbox-options.ts` — builds sandbox options from config
- `pourkit/execution/sandbox-image-build.ts` — builds Docker image if missing

### Current Mounts

```ts
mounts: [
  { hostPath: "~/.local/share/opencode", sandboxPath: "/home/agent/.local/share/opencode" },
  { hostPath: "~/.config/opencode", sandboxPath: "/home/agent/.config/opencode", readonly: true },
]
```

### OpenCode MCP Config

Pourkit's `opencode.json` supports `mcp` key for defining MCP servers.
Schema: `https://opencode.ai/config.json`

```json
{
  "mcp": {
    "serena": {
      "type": "remote",
      "url": "http://localhost:9121/mcp",
      "enabled": false
    }
  }
}
```

### Serena is Single-Project Stateful

From Serena docs: *"Serena is a stateful MCP server, and only one coding
project can be active at a time. Therefore, starting a single Serena
instance and connecting it to multiple clients is only appropriate if all
clients will be working on the same project."*

This constraint drives the entire Batch Baseline architecture below.

---

## Architecture Decision: Batch Baseline Model (recommended)

### Core Idea

Serena runs as a **long-lived Docker sidecar container** — separate from
all Sandcastle containers, not ephemeral, persists across Issue runs.

Serena indexes a **runner-owned Baseline Worktree** that tracks the active
Target's `baseBranch`. Parallel Issue Worktrees all share this same baseline
as read-only context. Agents never remount or swap Serena's project path.

Between Pourkit commands, Serena may be stale. That is acceptable because
each Serena-enabled command prepares the baseline before use.

### Why Not Remount Worktrees

Earlier proposal (Option A) remounted each Issue Worktree at Serena's stable
container path. This required:
- exclusive lease locking so only one Worktree used Serena at a time
- serialized access, breaking parallel Queue run support
- re-mount complexity in the Sandbox layer

Batch Baseline avoids all of these — concurrent Worktrees share the same
baseline read-only without contention.

### Architecture Diagram

```
Host machine
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Operator checkout (cwd)                                        │
│  /home/jacob/repos/pourkit                                       │
│                                                                  │
│  Pourkit CLI                                                     │
│  └─ creates Issue Worktrees under .pourkit/                     │
│  └─ creates/manages Serena Baseline Worktree                    │
│  └─ starts/stops Serena sidecar                                 │
│  └─ launches Sandcastle containers                               │
│                                                                  │
│  .pourkit/worktrees/issue-101/     (Issue A Worktree)           │
│  .pourkit/worktrees/issue-102/     (Issue B Worktree)           │
│  .pourkit/worktrees/issue-103/     (Issue C Worktree)           │
│                                                                  │
│  .pourkit/serena/baseline/active-repo/  (Serena Baseline)       │
│    checked out at origin/PRD-00N                                 │
│    managed by Pourkit CLI via normal git operations              │
│                                                                  │
│  .pourkit/serena/data/               (Serena persistent data)   │
│    config, project index, LS installs                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                                    │    │
          mount baseline ──────────┤    ├── mount data
                                    ▼    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Serena Sidecar Container (long-lived, separate from Sandbox)    │
│                                                                  │
│  Mounts:                                                         │
│    .pourkit/serena/baseline/active-repo  -> /workspaces/pourkit  │
│    .pourkit/serena/data/                 -> /workspaces/serena/  │
│                                                                  │
│  Serena MCP server endpoint: http://0.0.0.0:9121/mcp            │
│  Dashboard: http://0.0.0.0:24282                                  │
│                                                                  │
│  Reads from /workspaces/pourkit only                             │
│  Never edits Issue Worktrees                                     │
│  Index persists in /workspaces/serena/ volume                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                                    │
            http://host.docker.internal:9121/mcp
            ┌───────────┬───────────┐
            ▼           ▼           ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│ Sandcastle 101  │ │ Sandcastle 102 │ │ Sandcastle 103  │
│ (Issue A)       │ │ (Issue B)      │ │ (Issue C)       │
│                 │ │                │ │                  │
│ OpenCode agent │ │ OpenCode agent │ │ OpenCode agent  │
│ Mounted:        │ │ Mounted:       │ │ Mounted:         │
│ issue-101       │ │ issue-102      │ │ issue-103        │
│                 │ │                │ │                  │
│ Edits Worktree  │ │ Edits Worktree │ │ Edits Worktree   │
│ calls Serena    │ │ calls Serena   │ │ calls Serena     │
│ for baseline    │ │ for baseline   │ │ for baseline     │
│ context only    │ │ context only   │ │ context only     │
└────────────────┘ └────────────────┘ └────────────────┘
```

### Where Serena Does Not Live

Serena does not run inside Sandcastle. No Serena install in Sandbox
Dockerfile. No Serena index built inside Sandbox. Agent containers
connect to Serena over HTTP only.

---

## Batch Baseline Lifecycle

### Initial Setup (one time)

```
1. Run pourkit serena init
2. Pourkit creates .pourkit/serena/baseline/active-repo/ (git clone)
3. Pourkit creates .pourkit/serena/data/
4. Pourkit starts Serena container with mounts
5. Serena container runs serena project create --index /workspaces/pourkit
6. Index fully built. LS dependencies installed.
7. Serena data volume persisted. Container can stop now.
```

This is the **only** full index. Everything after is incremental.

### Serena-Enabled Queue Run

```
1. CLI: pourkit queue-run --target PRD-00N
2. Pourkit ensures Serena sidecar is running
3. Baseline Refresh:
   - cd .pourkit/serena/baseline/active-repo/
   - git fetch origin PRD-00N
   - git checkout --detach origin/PRD-00N
4. Serena file-watch/LSP catches up incrementally
   (or Pourkit restarts Serena if file-watch is unreliable)
5. Pourkit selects non-blocking Issues from target queue
6. For each Issue:
   - Create Issue Worktree from origin/PRD-00N
   - Create Sandbox container
   - Wire Serena MCP URL into Sandbox opencode config
   - Enable Serena for Builder and Refactor agents only
   - Run OpenCode agent
   - Agent uses Serena for baseline symbol context
7. As each Issue completes, PR merges into PRD-00N
8. After batch complete (all Issues done):
   - Baseline Refresh: pull origin/PRD-00N
   - Serena catches up with merged changes
9. queue-run exits
```

### Between Commands

```
- Serena sidecar may stay running
- Serena Baseline Worktree points at last active target
- Serena index may be stale relative to remote branches
- No timer, no background polling
- Next Serena-enabled command will Baseline Refresh before starting
```

### New Target, New Batch

```
- Target: dev, baseBranch: dev
- Baseline Refresh: fetch origin/dev, checkout origin/dev
- Serena sees same repo, new branch content
- If origin/dev already included merged PRD-00N changes,
  Serena incremental file-watch catches up
- No full reindex needed

- Target: PRD-00M, baseBranch: PRD-00M
- PRD-00M was created from dev before baseline refresh
- Baseline Refresh: fetch origin/PRD-00M, checkout origin/PRD-00M
- Since PRD-00M starts at same commit as dev, Serena sees zero change
- Immediate ready state
```

---

## State Management

### Serena State

Persists on host disk, not in container:

```
.pourkit/serena/data/
├── serena_config.yml
├── serena_config.docker.yml
├── projects/             # index data, symbol cache
├── memories/             # for agent project context
└── ...                   # LS installs, temp files
```

Serena container itself is stateless — all data is in the mount. Container
can be destroyed, restarted, or replaced without losing index.

### Serena Baseline Worktree

Git repository at:

```
.pourkit/serena/baseline/active-repo/
```

Managed by Pourkit CLI. Checked out at detached HEAD of target branch.
Fresh `git clone` created during `pourkit serena init`. Updated via
`git fetch && git checkout --detach` during Baseline Refresh.

One active baseline only. If multiple targets need Serena concurrently,
this is the serialization point (see Unresolved Questions).

---

## Tradeoff Analysis

### Option D: Batch Baseline (recommended)

Serena sidecar container. Serena indexes runner-owned Baseline Worktree at
target `baseBranch`. Parallel Issue Worktrees share same baseline as
read-only context.

**Pros:**
- Single index, created once, never fully reindexed per run
- Concurrent Worktrees share same Serena without locks
- No Worktree remount complexity
- Baseline refresh is cheap: `git fetch + checkout`
- Agents use baseline for symbol context, file tools for current Worktree
- Host OpenCode can also connect to same Serena
- Works with future parallel Queue run support
- No lease/lock contention

**Cons:**
- Serena index is stale during batch (baseline only, not current Worktree)
- Agents must not rely on Serena for uncommitted or sibling changes
- Requires per-Queue-run Baseline Refresh step
- Cannot serve two different target baseBranch concurrently with same instance
- Host OpenCode and Pourkit compete for same Serena baseline if both active

### Option A: Worktree Remount + Exclusive Lease (rejected)

Serena sidecar container. Each Issue run remounts its Worktree at Serena's
stable container path. Exclusive lease via lock file prevents concurrent
Serena access.

**Pros:**
- Serena sees current Worktree files (not stale)
- Agent can use Serena for post-edit validation

**Cons:**
- Serialized access: only one Worktree uses Serena at a time
- Breaks parallel Queue run — Worktree B must wait for Worktree A
- Remount complexity: Sandbox must map Worktree to secondary container path
- Lease management needed (acquire, detect stale, release)
- If lease holder dies, manually clear lock

**Verdict:** Rejected in favor of Batch Baseline. Concurrent reads are more
valuable than per-Worktree freshness.

### Option B: Serena Inside Sandbox Container (rejected)

Run Serena as a background process inside the Pourkit Sandbox container.

**Pros:**
- No path remapping. Serena sees same filesystem as OpenCode.
- No networking complexity.
- Single container to manage.

**Cons:**
- Serena instance dies with Sandbox. Index must be rebuilt every Issue run.
- Heavy process inside Sandbox (LSP servers, Serena server, OpenCode).
- Language server installs happen per Sandbox instance.
- Host cannot access Serena during Issue run.
- Per-Sandbox index cost: indexing a monorepo can take minutes.

**Verdict:** Rejected. Index is too expensive to rebuild per run.

### Option C: Serena as MCP stdio inside Sandbox (rejected)

Each OpenCode Sandbox agent starts Serena as an stdio MCP subprocess.

**Pros:**
- Trivially simple: `serena start-mcp-server` as command.
- No networking. No Docker compose.

**Cons:**
- Serena starts/stops with each agent run. Index rebuilt every time.
- Multiple Serena processes if multiple stages run.
- Host cannot access Serena.

**Verdict:** Rejected same as B.

---

## Indexing Policy

### Rule

One full index only. Never per-Issue Worktree, never per-stage, never
per-batch.

Index created during `pourkit serena init`. Subsequent operations rely on
Serena's incremental file-watch / LSP to update symbol information when
the Baseline Worktree changes.

### Expected Flow

1. **First setup** (`pourkit serena init`):
   - Start Serena container with baseline checkout at `/workspaces/pourkit`
   - `serena project create --index /workspaces/pourkit`
   - Persist Serena data in `.pourkit/serena/data/`
   - Verify index works

2. **Queue run start** (Baseline Refresh):
   - Fetch target `baseBranch`
   - Update Serena Baseline Worktree checkout
   - Wait for Serena file-watch / LSP to settle
   - Optionally: call Serena `restart_language_server` if supported
   - No `serena project index` call during any Issue run

3. **During batch execution**:
   - Serena remains pointed at baseline checkout
   - Agents read symbol context from baseline
   - Issue Worktrees change independently
   - Serena does not see those changes

4. **Post-batch** (Baseline Refresh):
   - Target branch advanced from merged PRs
   - Update baseline checkout to new target `baseBranch` HEAD
   - Serena file-watch catches merged changes
   - No full index

5. **Host dev work**:
   - Host connects to same Serena sidecar
   - Baseline checkout must be at host's desired branch
   - Shared state means host and Pourkit should not concurrently require
     different baselines

### Stale Index Detection

If Serena's incremental update does not detect baseline checkout changes
(flakey Docker bind-mount, LSP cache confusion), options:

- After baseline checkout update, touch a batch of key files to trigger
  LSP reparse
- Call `restart_language_server` if the optional tool is enabled
- Fallback: user runs `pourkit serena reindex` which calls full index
- No automatic full reindex in Pourkit code

### Batch Contract

Batch selection must choose non-blocking Issues from same target `baseBranch`
revision. This ensures all Worktrees branch off same baseline Serena knows
about.

If Issues depend on each other, they must be in separate batches or the
serialized Option A semantics apply for that batch.

---

## Serena Container Management

### Required Pourkit Commands

- `pourkit serena init`
  - Clone baseline repo into `.pourkit/serena/baseline/active-repo/`
  - Pull/verify Serena Docker image
  - Create persistent Serena data directory at `.pourkit/serena/data/`
  - Generate Docker Compose override or run command
  - Create `serena_config.yml` for Docker mode
  - Start container, run project create + index, stop

- `pourkit serena start` / `pourkit serena stop`
  - Start/stop the sidecar container
  - For host-side usage and Pourkit run preparation

- `pourkit serena status`
  - Health check endpoint
  - Reports whether baseline is up to date

- `pourkit serena reindex`
  - Manual full reindex for stale index recovery

- `pourkit serena refresh`
  - Baseline Refresh: update baseline checkout to target branch
  - Called internally by `queue-run` during Serena-enabled runs

### Serena Baseline Worktree Path

```
.pourkit/serena/baseline/active-repo/
```

One checkout only. Created by `serena init` (fresh clone). Updated by
`serena refresh` or Baseline Refresh step.

### Serena Data Storage

```
.pourkit/serena/data/        # gitignored
├── ...
```

Config files:

```yaml
# .pourkit/serena/data/serena_config.yml
gui_log_window: False
web_dashboard: True
web_dashboard_listen_address: 0.0.0.0
web_dashboard_open_on_launch: False
language_backend: LSP
excluded_tools: []
base_modes:
  - no-onboarding
  - no-memories
  - interactive
```

### Docker Network

`--network host` recommended:

- Serena accessible at `localhost:9121` from both host and Sandbox
- No `host.docker.internal` needed
- Sandboxes connect to `http://localhost:9121/mcp`
- Simpler, but port conflict risk if two Serena instances

If `--network host` is unavailable, bridge + `host.docker.internal`:

- Serena at `localhost:9121` for host
- Sandbox uses `http://host.docker.internal:9121/mcp`
- May need `--add-host` on Linux

---

## Pourkit Target Config

### New config surface

```ts
interface SerenaTargetConfig {
  enabled?: boolean;      // default false
  mcpUrl?: string;        // override MCP URL for this target
  context?: string;       // Serena context (default: "ide")
  modes?: string[];       // Serena modes to enable
}
```

### PourkitConfig change

```ts
interface PourkitConfig {
  // ... existing fields
  serena?: {
    enabled?: boolean;                // default false
    mcpUrl?: string;                  // default http://localhost:9121/mcp
    sandboxMcpUrl?: string;           // default http://localhost:9121/mcp
                                       // (--network host means same as mcpUrl)
    dataDir?: string;                 // default .pourkit/serena/
    autoStart?: boolean;              // default false
  };
}
```

### Env Override

```shell
POURKIT_SERENA_MCP_URL=http://localhost:9121/mcp
```

If set, enables Serena for the run regardless of target config (unless
target explicitly sets `serena.enabled: false`).

---

## OpenCode Config Integration

### Default (disabled)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "serena": {
      "type": "remote",
      "url": "http://localhost:9121/mcp",
      "enabled": false
    }
  }
}
```

### Per-Agent Enablement

Serena tools only for Builder and Refactor agents. OpenCode supports
per-agent tool enablement via `tools` field:

```json
{
  "agent": {
    "pourkit-builder": {
      "tools": {
        "serena_*": true
      }
    },
    "pourkit-refactor": {
      "tools": {
        "serena_*": true
      }
    }
  }
}
```

Combined with Pourkit CLI that toggles `mcp.serena.enabled` and URL based
on `POURKIT_SERENA_MCP_URL`.

### URL Switching

Host and Sandbox both use `http://localhost:9121/mcp` when `--network host`
is used. If bridge networking is necessary, host uses `localhost:9121` and
Sandbox uses `host.docker.internal:9121`.

Pourkit runner writes the correct URL into Sandbox `opencode.json` before
each agent run.

---

## Resolved Questions

The following were resolved during the Batch Baseline design session:

| Question | Resolution |
|----------|-----------|
| Sidecar vs Sandbox vs stdio | Sidecar (long-lived, separate container) |
| Index target | Runner-owned Baseline Worktree at target `baseBranch` |
| Per-Worktree index | Never. Single index created once. |
| Full reindex per batch | No. Baseline Refresh + incremental file-watch. |
| Parallel Worktrees + Serena | Concurrent Baseline Reads — same sidecar, same baseline |
| Serena per Worktree remount | Rejected. Would require serialized access. |
| Serena lifecycle after run | Remains running. Baseline may be stale. Next command refreshes. |
| Pourkit cwd vs target branch | Always target `baseBranch`, never cwd. |
| Host OpenCode access | Same Serena sidecar, but compete for Baseline Worktree. |
| `no-memories` mode | Recommended for Pourkit agents. |
| `no-onboarding` mode | Recommended for Pourkit agents. |
| `ide` context | Recommended for CLI agent use cases. |

---

## Validation Report

Validation commands attempted on this host:

- `docker version`
- `docker ps`

Observed result:

- Docker is unavailable in this environment (`docker: command not found`), so
  live Serena container checks could not be executed here.
- Because the runtime path is blocked at the Docker prerequisite, every Serena
  assumption below is marked blocked pending a Docker-capable host.

| Assumption | Command(s) | Observed behavior | Status | Implementation adjustment |
|------------|------------|-------------------|--------|---------------------------|
| Docker HTTP MCP startup | `serena start-mcp-server --transport streamable-http --port 9121 --host 0.0.0.0` | Not runnable here; Docker CLI missing. | blocked | Keep Serena opportunistic and gate enablement behind Docker availability checks. |
| Mounted repo indexing | `serena project create --index /workspaces/pourkit` | Not runnable here; no container to mount repo into. | blocked | Preserve one Baseline Worktree per active target and validate indexing on a Docker-capable host. |
| Checkout-triggered incremental updates | `git fetch origin <baseBranch>` + `git checkout --detach origin/<baseBranch>` | Not runnable here; live Serena file-watch could not be observed. | blocked | Keep Baseline Refresh + incremental update path; retain the optional restart fallback noted in the plan. |
| Sandcastle networking | `docker run ... --network host ...` | Not runnable here; Docker networking could not be exercised. | blocked | Keep `--network host` as preferred path and preserve bridge-network fallback guidance. |
| Multiple clients sharing one Serena sidecar | Parallel MCP clients against the same sidecar | Not runnable here; no live sidecar available. | blocked | Preserve single-sidecar, shared-baseline model and warn if a different baseline is required. |

---

## Unresolved Questions / Need to Investigate

### Serena Behavior

1. **Docker file-watch**: Does Serena's incremental index update work across
   Docker bind mounts? Baseline Refresh changes file contents under mount.
   Does LSP correctly detect and reparse?

2. **`restart_language_server` availability**: Can Pourkit call Serena's
   optional `restart_language_server` tool after Baseline Refresh? Is it
   reliable enough to avoid file-watch dependency?

3. **Baseline Worktree git operations**: Does `git checkout --detach`
   changing many files confuse Serena's LSP? Is a brief delay/settle needed
   before agents connect?

4. **`serena project index` idempotency**: If called on already-indexed
   project with different content, does it re-index or no-op?

5. **Language server installs in Docker**: Does Serena download TypeScript LS
   inside the container, or can we pre-install into the mounted data volume?

6. **Config reset**: Serena auto-generates `serena_config.docker.yml` if
   removed. Does the default include Docker-specific settings we need?

7. **Multiple Serena instances / port conflicts**: `SERENA_PORT` env var may
   control port. Needed only if running per-target Serena instances.

### Pourkit / Sandcastle

8. **Sandbox network**: Can Sandcastle Sandbox use `--network host` to
   reach Serena at `localhost:9121`? Current Sandbox networking pattern needs
   checking.

9. **Host + Pourkit competing for Serena**: If host OpenCode uses Serena
   while Pourkit needs a different baseline, who wins? Options:
   - Pourkit refuses if Serena is busy (check health, warn)
   - Pourkit takes baseline, host sees stale baseline until Pourkit done
   - Dedicated Serena for Pourkit, separate for host  (expensive)
   - Not an issue if both use same branch
   - Default: warn, let operator decide

10. **Per-target Serena baseline**: One Baseline Worktree means one active
    target at a time. If operator switches target between commands, the
    checkout changes. No isolation between targets. Acceptable?

11. **`serena.required: true/false`**: Should Serena be required or
    opportunistic? Recommended default: `required: false`. If unavailable,
    Builder/Refactor continue without it and log. Later targets can set
    `required: true` to fail fast.

### Operation Concerns

12. **CLI integration**: Should Pourkit manage Serena lifecycle (auto-start
    on `queue-run`), or should it be operator-managed (start Serena
    separately, Pourkit just connects)? Recommended: Pourkit manages, with
    explicit `pourkit serena start/stop` commands for host usage.

13. **Error handling**: What happens when Serena container is not running
    and a Serena-enabled command starts? Auto-start with clear log? Fail
    fast? Recommended: auto-start but fail-visible.

14. **Graceful degradation**: If Serena MCP endpoint is unreachable mid-run,
    should agents continue without Serena or fail? Recommended: continue
    with warning, log missing endpoint.

---

## Implementation Priority

### Phase 1: Validate Core Assumptions

1. Test Serena Docker image with `--transport streamable-http --host 0.0.0.0`
2. Test `serena project create --index` on a mounted repo
3. Test file-watch incremental update across Docker bind mount
4. Test `git checkout` changing files under Serena — does LSP catch up?
5. Confirm Serena config persists across container restarts with mounted volume
6. Confirm multiple HTTP clients (Sandbox agents) can call same Serena
   concurrently without interference

### Phase 2: Minimal Integration

1. Create `.pourkit/serena/` directory structure and generated config
2. Implement `pourkit serena init` command
3. Implement Serena Baseline Worktree setup (clone, git operations)
4. Implement Baseline Refresh logic (`git fetch + checkout`)
5. Add `serena` section to PourkitConfig schema
6. Wire Serena MCP URL into Sandbox opencode config per-agent
7. Add optional MCP URL env override

### Phase 3: Integration in Issue Run

1. If target has Serena enabled, ensure container running before execution
2. If target has Serena enabled, Baseline Refresh before Sandbox launch
3. If target has Serena enabled, configure opencode MCP in Sandbox before
   Builder/Refactor stages
4. Wire Serena context/modes per target config
5. Enable Serena tools only for Builder and Refactor agents

### Phase 4: Hardening

1. Error handling and health checks
2. Graceful degradation when Serena unavailable
3. Concurrent Worktree testing (multiple Sandboxes reading same Serena)
4. Host + Pourkit Serena competition handling
5. Documentation and developer guide

---

## Files Likely To Change

### Prompt / Config

- `opencode.json`
- `.pourkit/prompts/builder.prompt.md`
- `.pourkit/prompts/refactor.prompt.md`

### Orchestration

- `pourkit/execution/sandcastle-execution.ts`
- `pourkit/commands/issue-run.ts`
- `pourkit/commands/review.ts`
- `pourkit/shared/config.ts`
- `pourkit/shared/run-context.ts`

### Default Config / Init

- `.pourkit/strategy.ts`
- `pourkit.config.ts`
- `pourkit.config.example.ts`
- `pourkit/commands/init.ts`

### New Serena Subsystem

- `pourkit/commands/serena.ts`
- `pourkit/serena/manager.ts`
- `pourkit/serena/baseline.ts`
- `pourkit/serena/container.ts`

### Docs

- `.pourkit/CONTEXT.md`
- `.pourkit/docs/adr/<new-adr>.md`
- `.pourkit/handoffs/serena/glossary.md`
- `.pourkit/handoffs/serena/serena-documentation-reference.md`

---

## Glossary Reference

See `.pourkit/handoffs/serena/glossary.md` for domain terms:
- Serena Sidecar
- Serena Baseline Worktree
- Batch Baseline
- Baseline Refresh
- Batch-Boundary Refresh
- Single Index Rule
- Snapshot Oracle
- Concurrent Baseline Reads
- Serena-Enabled Command
- Lease (archived concept)

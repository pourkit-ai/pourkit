# ADR-0013: Serena Batch Baseline Integration

## Status

Accepted

## Context

Pourkit integrates Serena as an MCP server for code understanding via language servers. Serena is single-project stateful — it maintains one project index per repo and can only track one active project at a time. Pourkit operates multiple Issue Worktrees concurrently during Queue runs, each of which would ideally want Serena context for its own code.

Three requirements conflict with a simple integration:

1. **Single-project constraint**: Serena indexes one repo checkout. It cannot simultaneously serve multiple Worktrees with different content.
2. **Parallel Queue runs**: Pourkit processes non-blocking Issues in parallel Worktrees. Serena must not become a serialization bottleneck.
3. **Index cost**: Full `serena project create --index` can take minutes for a monorepo. Rebuilding the index per Issue or per Sandbox is unacceptable.

The design must resolve these constraints while keeping agents productive with symbol-level intelligence.

## Decision

Pourkit SHALL adopt the **Batch Baseline** architecture: Serena runs as a long-lived Docker sidecar container that indexes a runner-owned Baseline Worktree checked out at the active Target's `baseBranch`. All parallel Issue Worktrees share this one baseline as read-only context.

Specifically:

- **Serena Sidecar**: Long-lived Docker container running Serena MCP server over HTTP, separate from all Sandcastle containers. Mounts the Baseline Worktree at `/workspaces/pourkit` and Serena data directory at `/workspaces/serena/`. Persists across Issue runs.

- **Serena Baseline Worktree**: Runner-owned git checkout at `.pourkit/serena/baseline/active-repo/`, tracked at the active Target's `baseBranch` in detached HEAD state. Created once during `pourkit serena init`. Updated via `git fetch && git checkout --detach` during Baseline Refresh before each Serena-enabled command.

- **Baseline Refresh**: Fetch and checkout that updates the Baseline Worktree to the Target's `baseBranch` HEAD. Runs at the start of every Serena-enabled Pourkit command. After refresh, Serena's file-watch and LSP catch up incrementally — no full `serena project index` is called.

- **Snapshot Oracle**: Agents use Serena for baseline symbol context only. Agents must not use Serena for symbols introduced in their own Issue Worktree edits, sibling Worktree changes, or uncommitted diff validation. OpenCode file tools remain source of truth for current Worktree state.

- **Concurrent Baseline Reads**: Multiple Issue Worktrees simultaneously read the same Serena baseline. Safe because the baseline is read-only for agents — Serena answers symbol queries about the baseline commit only, with no lock contention or serialized access.

- **Single Index Rule**: One full index created during `pourkit serena init`. Subsequent operations rely on incremental file-watch / LSP updates. Never per-Issue Worktree, never per-stage, never per-batch.

- **Per-agent enablement**: Serena MCP tools are enabled for Builder and Refactor agents only. Reviewer and other roles do not get Serena access.

## Consequences

- Concurrent Worktrees share the same Serena index without locks, enabling parallel Queue run support.
- Index cost is paid once during initialization, not per-Issue or per-Sandbox.
- Baseline Refresh is cheap — `git fetch + checkout` — and does not trigger a full reindex.
- Agents have stale context during a batch: Serena reflects the base branch HEAD at batch start, not current Worktree edits. This is acceptable because agents use Serena for symbol navigation (declarations, references, diagnostics) while using OpenCode file tools for current Worktree state.
- A single Serena sidecar cannot serve two different Target `baseBranch` revisions concurrently. This is the serialization point if multi-target parallelism is needed later.
- Host OpenCode and Pourkit compete for the same Serena baseline if both are active. The Pourkit Baseline Refresh takes the baseline; the host sees a stale checkout until Pourkit completes.
- No Worktree remount or lease management is needed, eliminating a class of concurrency bugs.

## Alternatives Considered

- **Option A: Worktree Remount + Exclusive Lease**: Each Issue run remounts its Worktree at Serena's stable container path. Exclusive lease via a `.pourkit/serena/lease.json` lock file prevents concurrent Serena access. Rejected because it serializes Serena access — only one Worktree can use Serena at a time, breaking parallel Queue run support. Remount complexity and stale lease cleanup add operational overhead.

- **Option B: Serena Inside Sandbox Container**: Run Serena as a background process inside the Pourkit Sandbox container. Rejected because the Serena instance and its index die with the Sandbox container, requiring a full index rebuild per Issue run. Language server installs are repeated per Sandbox. Host cannot access Serena during the run.

- **Option C: Serena as MCP stdio inside Sandbox**: Each OpenCode Sandbox agent starts Serena as an stdio MCP subprocess. Rejected because Serena starts and stops with each agent role, requiring a full index rebuild each time. Multiple Serena processes run if multiple stages execute. Host cannot access Serena during the run.

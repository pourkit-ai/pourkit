# Serena Integration Glossary

Terms for the Serena + Pourkit integration. Maintain when new decisions or
patterns emerge.

---

## Serena (the tool)

External MCP tool providing code understanding via language servers. Gives
agents symbol search, declaration lookup, reference tracking, diagnostics.
Always runs inside Pourkit architecture as a long-lived Docker sidecar
container.

---

## Serena Sidecar

Long-lived Docker container running Serena MCP server. Separate from all
Sandcastle containers. Not ephemeral — persists across Issue runs. Mounts
two host paths:
- Serena Baseline Worktree at `/workspaces/pourkit`
- Serena data directory at Serena home (`/workspaces/serena/`)

Listens on HTTP port 9121. Both Pourkit Sandboxes and host OpenCode connect
to it as a remote MCP server.

---

## Serena Baseline Worktree

Runner-owned git checkout that Serena indexes. Checked out at the active
Target's `baseBranch`. Managed entirely by Pourkit CLI through normal git
operations. Path on host:

```
.pourkit/serena/baseline/active-repo/
```

Mounted into Serena sidecar at `/workspaces/pourkit`.

---

## Serena Data Directory

Persistent host directory holding Serena config, project index data, language
server installs, and memories. Path:

```
.pourkit/serena/data/
```

Mounted into Serena sidecar as Serena home (`/workspaces/serena/`). Survives
container restarts so LS installs and index are not re-downloaded.

---

## Batch Baseline

The git revision Serena indexes at the start of a Queue run batch. All
parallel Issue Worktrees in the same batch share this baseline context.

Agents see only baseline intelligence — symbol info from the base commit,
not unmerged sibling Worktree changes. Agents talk to the same Serena
sidecar HTTP endpoint regardless of which Worktree they run in.

---

## Baseline Refresh

Pourkit action that updates the Serena Baseline Worktree to a Target's
`baseBranch` HEAD. Runs at the start of every Serena-enabled Pourkit
command.

Sequence:

```
git fetch origin <baseBranch>
git checkout --detach origin/<baseBranch>
```

After refresh, Serena file-watch / LSP catches up incrementally. No full
`serena project index` is called.

---

## Batch-Boundary Refresh

A Baseline Refresh that happens after a batch of parallel Issues finishes
and the Target base branch advances (via PR merges). Updates Serena to see
merged results without a full reindex.

Target branch HEAD before batch → all Issue Worktrees branch off this.
Target branch HEAD after batch → merged PRs are present.
Baseline Refresh at batch boundary → Serena catches up incrementally.

---

## Single Index Rule

Serena is single-project and single-active-project stateful. It maintains
one project index per repo. Pourkit satisfies this constraint by keeping
exactly one Baseline Worktree that Serena always reads at
`/workspaces/pourkit`.

Index created once with `serena project create --index` during initial
setup. Subsequent updates use incremental file-watch / LSP, not full
`serena project index`.

---

## Snapshot Oracle

Serena provides intelligence about the **baseline commit**, not about
in-flight Worktree edits. Agents must not use Serena for:
- symbols they just introduced in their own Issue Worktree
- files changed by a sibling Issue Worktree in the same batch
- post-edit validation of uncommitted diff
- refactoring decisions that depend on current agent edits

OpenCode file tools remain source of truth for current Worktree state.

---

## Concurrent Baseline Reads

Multiple Issue Worktrees simultaneously reading the same Serena baseline.
Safe because the baseline is read-only for agents. Serena answers symbol
queries about the baseline commit only. No lock contention, no serialized
access needed.

This is the key difference from the earlier Lease model (archived).
Concurrent reads eliminate the serialization bottleneck while preserving
a single warmed index.

---

## Serena-Enabled Command

A Pourkit command that uses Serena alongside OpenCode agents. Currently
`queue-run` when the Target has `serena.enabled: true`.

Prepares Baseline Worktree before Sandbox stages. Wire Serena MCP URL into
Sandbox OpenCode config per-agent (active for Builder and Refactor only).

---

## Single Serena Index Rule

(see Single Index Rule — redundant alias. Keep both for search matching.)

---

## Lease (archived concept)

Earlier proposal: exclusive Serena access per Worktree via a
`.pourkit/serena/lease.json` lock file. Each Issue run would remount
its Worktree at the stable Serena path and hold a lease against competing
runs.

Replaced by Concurrent Baseline Reads + Batch Baseline model. The lease
approach required serialized Serena access, which conflicts with parallel
Queue run support. The batch-baseline approach allows shared reads without
contention while still maintaining one warmed index.

Notable if old handoff mentions are encountered — the lease model was
discussed during Option A (Worktree Remount) and rejected for the Batch
Baseline model.

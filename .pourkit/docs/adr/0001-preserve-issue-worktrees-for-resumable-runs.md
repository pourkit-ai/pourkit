# ADR-0001: Preserve Issue Worktrees for Resumable Runs

## Status

Accepted

## Context

Pourkit creates a Git worktree per Issue for isolated implementation work. When a run fails (e.g., verification failure, review rejection, timeout), the current behavior deletes the existing worktree before rerunning. This loses all local state — including partial fixes, review responses, and uncommitted changes — forcing the builder to start from scratch.

As Issue complexity grows and review loops span multiple iterations, discarding worktree state on each rerun becomes costly and wasteful.

## Decision

Reuse existing Issue Worktrees by default on rerun. The runner checks for Worktree Run State (`.pourkit/state.json` inside the Worktree) to determine whether a failed run can be resumed. A new `--reset-worktree` flag provides an explicit destructive local reset when a clean environment is needed.

Worktree Run State is runner-owned local metadata, not agent-editable prompt context. It is stored per Worktree and scoped to the local machine.

## Consequences

- Resume is local-machine scoped — Worktree Run State is not pushed to remotes or shared across machines.
- Cleanup and discovery commands are out of scope of this decision; remote PR cleanup is not part of `--reset-worktree`.
- `--reset-worktree` is the explicit mechanism for a destructive local reset.

## Alternatives Considered

- **Checkpoint commits**: Committing partial state to the branch before teardown. Rejected because it pollutes the commit history with incomplete work and makes rebase/squash workflows harder.
- **Patch files**: Writing a diff to a temporary file and reapplying on rerun. Rejected because patches cannot capture uncommitted new files, binary assets, or worktree metadata.
- **Explicit `--resume` flag**: Requiring an opt-in flag to preserve the worktree. Rejected because preserving state is the safer default; losing work should require explicit intent.
- **Global run registry**: A central JSON store outside Worktrees tracking all run state. Rejected because it couples runs across Issues and complicates cleanup when Worktrees are removed independently.

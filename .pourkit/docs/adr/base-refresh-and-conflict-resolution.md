# ADR: Base Refresh and Conflict Resolution

## Status

Accepted

## Context

PRD-034 (#1148) introduced two workflow capabilities for handling stale worktrees and rebase conflicts during Pourkit resume: Base Refresh and Conflict Resolution Agent.

Before this decision, when a Pourkit run failed and the repository's base branch had advanced, a subsequent resume attempt would proceed against a stale branch. Rebase conflicts during resume had no automated resolution path — the issue was transitioned to `ready-for-human` with no agent involvement.

The team evaluated how these capabilities should be owned (runner vs. agent), how Git state transitions should be managed, what artifact contract the Conflict Resolution Agent should follow, and how verification should interact with rebase.

## Decision

### Rebase with Autostash

The runner SHALL use `git rebase --autostash <baseBranch>` for Base Refresh. Autostash ensures that any uncommitted worktree changes are stashed before rebase and reapplied afterward, preventing data loss during resume.

Rationale: Worktree state may contain artifacts from a previous run (e.g., verification outputs, log files). Autostash handles these without requiring explicit cleanup.

### Published History Refusal

Base Refresh SHALL refuse to rebase any branch that already has an associated GitHub PR (open, closed, or merged). When a PR exists, the runner SHALL return `refused-published-history` and throw, preventing automated rebase of published history.

Rationale: Rebasing a branch with a published PR rewrites shared history, which violates common Git collaboration conventions and disrupts PR reviewers. The runner must not automate destructive history rewrites.

### Runner Ownership of Git State Transitions

The runner SHALL own all Git commands during Base Refresh and Conflict Resolution:

- Staleness check (`git merge-base --is-ancestor`)
- Rebase (`git rebase --autostash`)
- Staging resolved files (`git add`)
- Continuing rebase (`git rebase --continue`)
- State invalidation after successful refresh (`invalidateAfterBaseRefresh`)

The Conflict Resolution Agent SHALL only edit conflicted file content and write a structured Artifact. The agent SHALL NOT run `git add`, `git rebase --continue`, `git reset`, `git push`, `git merge`, create PRs, merge PRs, or post issue comments.

Rationale: Keeping Git state transitions in the runner ensures consistency, prevents agent hallucinations from executing destructive Git commands, and maintains a single source of truth for workflow state. This separation mirrors the existing pattern where the Builder edits files but the runner handles branch creation and worktree setup.

### Conflict Resolution Artifact Contract

The Conflict Resolution Agent SHALL produce a structured Artifact with the following sections:

```
## Status
resolved|ambiguous

## Summary
<text description>

## Files
- `<filepath>`
- `<filepath>`
```

Plus a closing line marker that matches the status value:

```
<conflict-resolution>resolved|ambiguous</conflict-resolution>
```

The runner SHALL parse and validate this Artifact. Protocol errors (empty output, duplicate sections, missing sections, duplicate markers, status/marker mismatch) cause the runner to return `failed`.

Rationale: A structured Artifact contract allows the runner to deterministically interpret the agent's intent. The `<conflict-resolution>` marker provides a redundant check against malformed output. The `resolved`/`ambiguous` dichotomy gives the agent a clear signal when it cannot fully resolve a conflict.

### Total maxAttempts for Conflict Resolution

The Conflict Resolution Agent SHALL be invoked with a total `maxAttempts` limit across all conflict-resolution rounds within a single resume. Each round may resolve one set of conflicting files; if `git rebase --continue` reveals new conflicts, the attempt counter continues accumulating. When `maxAttempts` is exhausted with remaining conflicts, the runner SHALL return `exhausted` and transition the issue to `ready-for-human`.

Rationale: A single attempt limit avoids infinite loops while preventing the agent from consuming excessive run time on intractable conflicts. The `maxAttempts` value is configured per Strategy and reflects the expected difficulty of conflicts in that lane.

### Verification After Full Rebase

Verification commands SHALL run only after the full rebase completes (all conflicts resolved, `git rebase --continue` succeeds). Verification SHALL NOT run after individual conflict-resolution rounds.

Rationale: The branch is in an inconsistent state during an active rebase. Running verification mid-rebase would produce unreliable results. After the rebase completes and `invalidateAfterBaseRefresh` resets verification/finalizer state, the next workflow stage runs verification against the fully rebased branch.

## Consequences

- Base Refresh is a runner-owned step that runs only on resume of preserved worktrees or existing branches, never on fresh first-time runs.
- Conflict Resolution Agent is an optional Strategy role; Strategies without `conflictResolution` config still transition conflicted resumes to `ready-for-human`.
- After successful Base Refresh (with or without conflict resolution), `invalidateAfterBaseRefresh` preserves builder completion but resets review iteration count to zero and drops verification, finalizer, finalCommit, and PR completion flags.
- If Base Refresh succeeds without conflicts, no Conflict Resolution Agent is invoked regardless of configuration.
- Conflict Resolution Agent decisions do not persist across distinct Issue runs — each resume starts from the stored Worktree Run State.
- Agents cannot execute Git commands, push, create PRs, merge PRs, or post comments — enforced by architecture not convention.
- The runner-parsed Conflict Resolution Artifact is validated structurally; the runner does not interpret the summary or file list contents beyond checking section existence and the status marker.

## Alternatives Considered

- **Runner-enforced branch refresh before every run**: Rejected because fresh first-time issue runs start from the base branch and do not need a rebase. Base Refresh is only meaningful for resumes.
- **Agent-owned Git commands**: Rejected because it would give agents destructive Git capabilities (rebase, push, merge) that could rewrite published history or create inconsistent states. Runner ownership mirrors the existing pattern where the runner owns worktree creation and branch setup.
- **Conflict resolution as a Refactor sub-role**: Rejected because Refactor addresses Reviewer feedback in a review loop, which is a fundamentally different concern from rebase conflicts during resume. Refactor runs in a separate stage with different run context (includes review-criteria).
- **Verification after each conflict-resolution round**: Rejected because the branch is in an inconsistent state during an active rebase (detached HEAD, rebase-merge directory present). Verification results would be unreliable.
- **Unlimited conflict resolution attempts**: Rejected because it could consume excessive run time on unresolvable conflicts. A configured `maxAttempts` bound provides a clear exhaustion signal.

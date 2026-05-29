# Handoff: Base Refresh and Conflict Resolution Agent

## Problem

When a Pourkit session is paused/resumed, the user may have made changes to the `baseBranch` that the issue Worktree was branched from. The issue Worktree/branch is stale (still rooted at the old base). This causes:

- Base work to appear as dirty changes in the resumed Worktree because Pourkit compares/`reset --soft` against the updated base.
- Finalization to potentially fold unrelated base changes into the issue commit.

## Solution: Base Refresh

A new runner-owned workflow step called **Base Refresh** that runs before resuming any preserved issue Worktree or existing issue branch.

### Trigger

- Always before resume when the issue Worktree/branch is preserved and stale.
- Does **not** run for fresh first-time issue runs (already created from latest base).
- Does **not** run if a PR has already been created or merged (refuses to rewrite published history).

### Mechanism

```
git rebase --autostash <baseBranch>
```

- Rebase is used, not merge — keeps commit history linear and matches Pourkit's eventual `reset --soft` finalization model.
- `autostash` preserves dirty Worktree changes from a previously paused session.

### Flow

```
Resume existing issue Worktree/branch
  |
  v
sync latest Target baseBranch (already exists: syncTargetBranch)
  |
  v
is issue branch stale?
  |
  +-- no -> resume normally
  |
  +-- yes
        |
        v
      has PR already been created/merged?
        |
        +-- yes -> stop; error: cannot auto-refresh published history
        |
        +-- no
              |
              v
            git rebase --autostash <baseBranch>
              |
              +-- success
              |     |
              |     v
              |   invalidate downstream resume state
              |   resume at review path (not builder)
              |
              +-- conflict
                    |
                    v
                  strategy has conflictResolution?
                    |
                    +-- no -> preserve conflicted Worktree
                    |         transition issue to ready-for-human
                    |         write lastFailure
                    |
                    +-- yes -> run Conflict Resolution Agent
```

### State Handling After Successful Refresh

**Keep:**
- issueNumber
- targetName
- branchName
- baseBranch
- completedStages.builder

**Clear:**
- review.lastVerdict
- review.lastArtifactPath
- review.refactorCompletedForLastReview
- review.exhaustedPreviousRun
- finalizer
- finalCommit
- pr

Reason: the code being reviewed/finalized changed semantically after rebase. Review must rerun.

---

## Conflict Resolution Agent

A new Strategy-level agent role that resolves rebase integration conflicts during Base Refresh.

### Config Shape

```ts
export interface ReviewRefactorLoopStrategyInput {
  type: "review-refactor-loop";
  implement: {
    builder: StageAgentConfig;
  };
  conflictResolution?: StageAgentConfig & {
    maxAttempts: number;
  };
  review: { ... };
  finalize: { ... };
}
```

`conflictResolution` is optional at the Strategy level. If absent, Base Refresh conflicts always hand off to human.

### Agent Contract

**Agent does:**
- Inspect conflict context via `git status`, `git diff`, `git diff --ours`, `git diff --theirs`, `git show :1:`, `git show :2:`, `git show :3:`.
- Preserve latest baseBranch behavior as authoritative existing project state.
- Reapply compatible issue work on top of the updated base.
- Edit conflicted files.
- Optionally edit supporting non-conflicted files if integration requires it.
- Write structured artifact with outcome.

**Agent does NOT:**
- Run `git add`, `git rebase --continue`, `git rebase --abort`, `git reset`.
- Run `git checkout --ours` or `git checkout --theirs` globally.
- Run `git push`, `gh pr create`, `gh pr merge`, `gh issue comment`.
- Run verification commands.

### Runner Contract

**Runner does:**
- Capture originally conflicted paths before invoking agent: `git diff --name-only --diff-filter=U`.
- Run conflictResolution agent in conflicted Worktree.
- Parse structured artifact.
- Verify no unresolved conflict markers remain in originally conflicted paths.
- `git add <original conflicted paths only>`. Does **not** stage non-conflicted supporting edits.
- `git rebase --continue`.

### Artifact Contract

```md
## Status

resolved

## Summary

- Preserved latest baseBranch behavior.
- Reapplied issue validation change on top of the new base flow.

## Files

- `src/foo.ts`
- `src/foo.test.ts`

<conflict-resolution>resolved</conflict-resolution>
```

Allowed statuses: `resolved`, `ambiguous`.

### Conflict Resolution Loop

```
rebase conflict
  |
  v
capture conflicted paths
  |
  v
run Conflict Resolution Agent
  |
  v
parse artifact
  |
  +-- ambiguous -> preserve Worktree, ready-for-human
  |
  +-- resolved
        |
        v
      verify original conflict paths are resolved
        |
        v
      git add <original conflicted paths only>
        |
        v
      git rebase --continue
        |
        +-- more conflicts -> repeat up to maxAttempts (total invocations)
        |
        +-- full rebase success
              |
              v
            invalidate downstream state
            run verification once (after full rebase)
            rerun review
```

**maxAttempts** counts total conflict-resolution agent invocations across the entire rebase, not per commit.

**Verification runs only after the entire rebase finishes**, not per conflict. During a multi-commit rebase, the Worktree does not represent final issue state yet.

### Prompt Hard Rules

The conflict-resolution prompt must include:

```
- Do not discard baseBranch behavior just to keep the issue patch.
- Do not blindly choose ours/theirs.
- Do not run git add, git rebase --continue, git rebase --abort, git reset.
- Do not run push, PR, merge, issue-comment commands.
- Do not run verification.
- If the semantic merge is unclear, write status: ambiguous.
- Write only the structured artifact; do not provide a separate chat response.
```

---

## New Terms for CONTEXT.md

**Base Refresh:**
Runner-owned workflow step that updates a stale preserved issue Worktree/branch onto the latest Target baseBranch before resuming. Uses `git rebase --autostash <baseBranch>`.

**Conflict Resolution Agent:**
A Strategy-level agent role that resolves Base Refresh rebase conflicts by editing files only and producing a structured resolved/ambiguous artifact. Does not own Git state transitions — the runner stages paths and continues the rebase.

---

## New Execution Stage

Add `conflictResolution` to the Pourkit stage type.

```ts
type PourkitStage = "builder" | "reviewer" | "refactor" | "finalizer" | "conflictResolution";
```

Add to run-context stage sections:

```ts
STAGE_SECTIONS: Record<PourkitStage, RunContextSection[]> = {
  ...
  conflictResolution: [
    "issue", "comments", "branch", "verification-commands", "artifacts"
  ],
};
```

Add to Worktree Run State:

```ts
WorktreeRunStage = "builder" | "verification" | "review" | "refactor"
  | "finalizer" | "finalCommit" | "pr" | "baseRefresh" | "conflictResolution";
```

---

## Implementation Order

1. Extend Strategy config schema/types with optional `conflictResolution`.
2. Add `conflictResolution` to PourkitStage and run-context sections.
3. Add `baseRefresh` and `conflictResolution` to WorktreeRunStage.
4. Add Base Refresh helper: stale check, rebase, state invalidation.
5. Wire Base Refresh into `startIssueRun` (or equivalent entry point) for existing Worktree and existing-branch resume paths.
6. Add conflict-resolution artifact parser.
7. Add conflict-resolution prompt template at `.pourkit/prompts/conflict-resolution.prompt.md`.
8. Add conflict-resolution runner loop in issue-run flow.
9. Add tests for: clean refresh, stale skip (already current), conflict without config, conflict with resolved artifact, ambiguous artifact, invalid artifact, supporting dirty edits, repeated conflicts consuming total maxAttempts, maxAttempts exhaustion, PR-created refusal, downstream state invalidation, verification/review only after full refresh.

---

## Skills for Next Session

- `work-on-issue` — to implement from the resulting issues.
- `grill-with-docs` — to stress-test terminology against existing domain language before finalization.

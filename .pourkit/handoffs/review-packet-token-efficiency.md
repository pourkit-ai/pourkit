# Review Packet Token Efficiency Plan

## Purpose

Introduce a runner-generated **Review Packet** for the Pourkit **Reviewer**. The packet gives the Reviewer a compact, trustworthy discovery map of candidate changes before it chooses which diffs, files, and tests to inspect deeply.

Primary goal: reduce repeated broad context reads during review/refactor loops while preserving Reviewer correctness and independence.

The Review Packet narrows discovery. It must not replace direct verification of the current Worktree, current diff, source files, or tests.

## Resolved Product Direction

- Add a new runner-generated context file at `.pourkit/.tmp/review-packet.md`.
- Generate it before every Reviewer iteration, including after each Refactor attempt.
- Use it only for the Reviewer in the first implementation.
- Keep Refactor behavior unchanged.
- Keep prior Reviewer and Refactor artifacts injected exactly as they are today.
- Do not add intermediate commits during review/refactor loops for token efficiency.
- Do not fetch during packet generation; rely on the existing Target base sync performed earlier in the Issue run.
- Fail closed when required Git commands fail, because incomplete diff context can cause false PASS decisions.
- Update `.pourkit/CONTEXT.md` with the Review Packet domain term and relationship.
- Do not create an ADR for this change.

## Domain Language

Add this glossary term to `.pourkit/CONTEXT.md`:

```markdown
**Review Packet**:
A runner-generated Reviewer context file that summarizes current candidate changes for discovery, including changed paths, diffstat, name-status, untracked files, and inspection guidance. It is not an Artifact and not source of truth; Reviewer uses it to choose targeted diff/source/test reads.
_Avoid_: Review Artifact, Run Context, diff source of truth
```

Add this relationship:

```markdown
- A **Reviewer** starts with the **Review Packet** for change discovery, then verifies current diff and relevant files directly before producing findings
```

Important term boundary:

- **Review Packet** is not an **Artifact** because Pourkit glossary defines Artifact as a file produced by an agent role. Review Packet is produced by the runner.
- **Review Packet** is not **Run Context** because Run Context is stable cross-role workflow context. Review Packet is Reviewer-specific and volatile because it summarizes current diff state.
- **Review Packet** is not source of truth. Current Worktree, Git diff, source files, tests, and issue requirements remain source of truth.

## Current Behavior

- Reviewer prompt is built in `pourkit/commands/review.ts` by `buildReviewerPrompt()`.
- Reviewer runs as `pourkit-reviewer` from `opencode.json` with `permission.task: "deny"`, so it cannot spawn subagents.
- Runner writes `.pourkit/.tmp/run-context.md` using `buildRunContextArtifact()` in `pourkit/shared/run-context.ts`.
- Reviewer Run Context includes issue details, comments, branch info, verification commands, review criteria names, and artifact paths.
- Reviewer prompt instructs agent to inspect current Git diff and directly touched files.
- Runner does not currently precompute or write a changed-file list, diffstat, name-status summary, untracked file list, or Review Packet.
- Later review iterations may include prior Reviewer and Refactor artifacts in prompt via `renderPriorReviewerArtifacts()` and `renderPriorRefactorArtifacts()`.
- Refactor changes remain dirty in the shared Worktree during review/refactor loop.

## Existing Base Sync Behavior

Do not add a fetch inside Review Packet generation.

Existing behavior already syncs the Target base before review work:

- `issue-run.ts` calls `resolveIssueWorktree(ROOT, branchName, target.baseBranch, logger)`.
- `resolveIssueWorktree()` calls `syncTargetBranch()` for existing Worktree resume, existing branch resume, and new runs.
- `syncTargetBranch()` runs `git fetch origin <baseBranch>` and returns `origin/<baseBranch>`.
- `refreshStaleIssueBranch()` then uses the returned `baseRef` for Base Refresh.

Implication:

- Review Packet generation should use the already-synced `baseRef` from issue-run flow.
- If called directly in tests or standalone paths without `baseRef`, fallback to `origin/${target.baseBranch}`.
- If that base ref is missing or `git merge-base` fails, fail closed with a clear error.

## Token Efficiency Rationale

The packet reduces tokens by changing the Reviewer’s first move from broad discovery to targeted inspection.

Expected wins:

- Reviewer gets changed paths upfront instead of spending tokens on repeated broad `git status`, `git diff`, directory listing, and whole-file reads just to discover scope.
- Diffstat and name-status point Reviewer to high-risk files first.
- Changed-file table avoids duplicate reasoning across committed, dirty, and untracked states.
- Prompt references packet path instead of inlining diff output, keeping prompt small.
- Packet excludes full diff hunks, preventing large diffs from recreating the token problem.
- Explicit command hints steer Reviewer toward targeted `git diff` hunks and focused file reads.
- Prior artifacts remain unchanged for first implementation, avoiding lossy summarization and protocol risk.

Limits:

- Savings are behavioral, not guaranteed by runner alone.
- Prompt wording must instruct Reviewer to start with the packet and avoid broad whole-file reads unless needed.
- Reviewer independence remains required; packet is discovery context only.

Manual validation:

- Compare saved reviewer prompt size before/after using `.pourkit/.tmp/prompts/reviewer-iteration-*`.
- Review OpenCode logs for fewer broad file reads and fewer broad diffs.
- Avoid automated token accounting unless provider exposes reliable usage data.

## Review Scope Model

Use remote-backed Target base as canonical base:

- Base ref: `baseRef` from Issue run, usually `origin/${target.baseBranch}`.
- Merge base: `git merge-base HEAD <baseRef>` run in the Issue Worktree.

Normal loop behavior:

- Worktree is created from Target base.
- Builder, Reviewer, and Refactor share the same Worktree.
- Builder and Refactor changes remain dirty during review/refactor loop.
- Candidate implementation is usually dirty Worktree changes relative to `HEAD`.

Defensive behavior:

- Packet still includes committed branch delta because unusual committed changes can exist after resume, manual intervention, or future workflow changes.
- Packet includes aggregate tracked Review Scope from merge base to current Worktree so Reviewer sees all tracked candidate changes relative to base.
- Packet separately includes untracked files because Git diff cannot show them.

## Git Commands

Run all packet commands in `worktreePath`, not `repoRoot`.

Required commands should fail closed:

```bash
git rev-parse --verify <baseRef>
git merge-base HEAD <baseRef>
git diff --stat --no-renames <mergeBase>
git diff --name-status --no-renames <mergeBase>
git diff --numstat --no-renames <mergeBase>
git diff --stat --no-renames <mergeBase>...HEAD
git diff --name-status --no-renames <mergeBase>...HEAD
git diff --stat --no-renames HEAD
git diff --name-status --no-renames HEAD
git status --short
```

Optional/tolerated command:

```bash
git ls-files --others --exclude-standard
```

If untracked listing fails after required Git state commands succeed, render an explicit warning in the packet instead of failing whole review.

Do not add `--find-renames`. Use `--no-renames` for deterministic touched-path output. Delete/add output is acceptable because token-efficiency goal needs touched paths, not rename semantics.

Do not inline full diff hunks in packet.

## Packet Contents

Write packet to:

```text
.pourkit/.tmp/review-packet.md
```

Use stable markdown headings. Content is not a parser protocol; headings are stable for tests and human readability.

Recommended section order:

```markdown
# Pourkit Review Packet

## Issue

## Diff Base

## Changed Files

## Review Scope

## Committed Branch Delta

## Dirty Worktree Delta

## Untracked Files

## Git Status

## Inspection Guidance
```

### Issue

Include concise issue metadata already available to the runner:

- Issue number
- Issue title
- Target name if readily available
- Working branch

Do not duplicate full issue body or comments. Reviewer reads those from Run Context.

### Diff Base

Include:

- Target base branch, e.g. `dev`
- Base ref, e.g. `origin/dev`
- Merge base SHA
- Working branch
- Note that base ref was expected to be synced before packet generation

### Changed Files

One row per changed path.

Table columns:

```markdown
| Path | Sources | Binary/Size | Notes |
|------|---------|-------------|-------|
```

Source markers:

- `scope:<status>` from aggregate tracked Review Scope
- `committed:<status>` from committed branch delta
- `dirty:<status>` from dirty Worktree delta
- `untracked:A` from untracked file list

Examples:

```markdown
| pourkit/commands/review.ts | scope:M, dirty:M | text | n/a |
| assets/logo.png | scope:M, dirty:M | binary/unknown-size | binary from numstat |
| pourkit/shared/review-packet.ts | untracked:A | unknown | untracked file |
```

Combine sources/statuses into one row per path. Do not duplicate rows when same path appears in multiple deltas.

Use aggregate `git diff --numstat --no-renames <mergeBase>` to mark binary files. Binary rows show `-\t-\tpath`; mark as `binary/unknown-size`.

If no tracked changes and no untracked files, render loud empty markers:

```markdown
(no tracked changes)
(no untracked files)
```

### Review Scope

Aggregate tracked changes relative to merge base and current Worktree.

Commands represented:

```bash
git diff --stat --no-renames <mergeBase>
git diff --name-status --no-renames <mergeBase>
git diff --numstat --no-renames <mergeBase>
```

This includes committed changes plus staged/unstaged tracked Worktree changes.

Use two-dot form from merge base to Worktree. Do not use three-dot here.

### Committed Branch Delta

Defensive section for committed changes on branch.

Commands represented:

```bash
git diff --stat --no-renames <mergeBase>...HEAD
git diff --name-status --no-renames <mergeBase>...HEAD
```

This is expected to be empty in normal review/refactor loop because candidate changes usually remain dirty.

### Dirty Worktree Delta

Primary normal-loop candidate changes for tracked files.

Commands represented:

```bash
git diff --stat --no-renames HEAD
git diff --name-status --no-renames HEAD
```

Do not split staged vs unstaged in first implementation. Current workflow treats all implementation and review/refactor changes as dirty Worktree changes.

### Untracked Files

Command represented:

```bash
git ls-files --others --exclude-standard
```

Render `(no untracked files)` when empty.

If command fails, render a warning but keep packet if required commands succeeded.

### Git Status

Command represented:

```bash
git status --short
```

Include full output or `(clean)` if empty.

This helps Reviewer see staged vs unstaged indicators, untracked files, and unusual states without splitting dirty delta into multiple sections.

### Inspection Guidance

Include concise guidance:

- Start here for discovery only.
- Treat packet as runner-generated discovery context, not source of truth.
- Verify current diff, relevant source files, tests, and issue requirements directly before findings.
- Prefer targeted `git diff` hunks and focused file reads over whole-file reads.
- Avoid deep reads of generated files, lockfiles, large files, or binary files unless directly relevant to correctness or scope.
- If Changed Files is empty, do not PASS until checking issue requirements, `git status --short`, and whether implementation was expected to change files.

Include explicit command hints:

```bash
git diff --stat --no-renames <mergeBase>
git diff --name-status --no-renames <mergeBase>
git diff --numstat --no-renames <mergeBase>
git diff --stat --no-renames <mergeBase>...HEAD
git diff --name-status --no-renames <mergeBase>...HEAD
git diff --stat --no-renames HEAD
git diff --name-status --no-renames HEAD
git status --short
```

## Prompt Changes

Update `.pourkit/prompts/reviewer.prompt.md` so Reviewer is required to inspect:

- Selected issue requirements.
- Shared Run Context.
- Review Packet.
- Current Git diff/source/tests directly as needed.
- Directly touched files selected from packet/diff discovery.

Recommended wording:

```markdown
Start with `.pourkit/.tmp/review-packet.md` to choose what to inspect. Treat it as runner-generated discovery context, not source of truth. Verify current diff and relevant source/tests directly before issuing findings.
```

Add empty-scope policy:

```markdown
If the Review Packet shows no changed files, do not PASS until you have checked the issue requirements, `git status --short`, and whether the implementation was expected to change files.
```

Keep prior-artifact authority boundary:

```markdown
Treat prior Reviewer and Refactor artifacts as historical context, not source of truth.
```

Update `buildReviewerPrompt()` in `pourkit/commands/review.ts` to reference the Review Packet path in the generated prompt.

Do not inline Review Packet contents into the prompt.

## Implementation Plan

### 1. Add Review Packet Module

Create:

```text
pourkit/shared/review-packet.ts
```

Exports:

```ts
export const REVIEW_PACKET_PATH_IN_WORKTREE = ".pourkit/.tmp/review-packet.md";

export interface ReviewPacketOptions {
  issue: IssueData;
  target: Target;
  branchName: string;
  worktreePath: string;
  baseRef?: string;
  logger: PourkitLogger;
}

export async function buildReviewPacketArtifact(
  options: ReviewPacketOptions
): Promise<ExecutionArtifact>;
```

Implementation notes:

- Default `baseRef` to `origin/${target.baseBranch}` only when missing.
- Use `execCapture()` from `pourkit/shared/common.ts`.
- Run commands with `cwd: worktreePath`.
- Fail closed for required command failures.
- Wrap errors with useful context, e.g. `Failed to build Review Packet: unable to resolve merge base for HEAD and origin/dev`.
- Keep collection helpers and renderer in same module for first implementation.
- Avoid adding generic abstractions unless tests force them.

Possible internal helpers:

```ts
async function runGit(...): Promise<string>
function parseNameStatus(output: string): Array<{ status: string; path: string }>
function parseUntracked(output: string): string[]
function parseNumstatBinaryPaths(output: string): Set<string>
function buildChangedFileRows(...): ChangedFileRow[]
function renderReviewPacketMarkdown(...): string
```

Parsing notes:

- `git diff --name-status --no-renames` emits status and path separated by tabs.
- With `--no-renames`, no rename two-path rows should be emitted.
- Handle empty output as empty arrays.
- For status values, preserve raw Git status code (`M`, `A`, `D`, etc.).
- For `git status --short`, preserve raw lines.
- For paths, do not try to quote/unquote beyond Git output unless existing helpers exist.

### 2. Plumb Base Ref Into Review Flow

Add optional `baseRef?: string` to relevant review options:

- `RunReviewOptions`
- `runReviewCommand()` call sites
- Review loop options type, if distinct

In `issue-run.ts`, pass the `baseRef` returned by `resolveIssueWorktree()` into review loop and then into `runReviewCommand()`.

Direct tests or standalone calls can omit `baseRef`, causing fallback to `origin/${target.baseBranch}`.

Do not introduce extra fetch.

### 3. Write Packet As Reviewer Execution Artifact

In `runReviewCommand()`:

- Build Review Packet immediately before `executionProvider.execute()`.
- Add it to `artifacts` alongside `buildRunContextArtifact(...)`.
- Regenerate every Reviewer iteration because Refactor changes dirty Worktree state.

Expected shape:

```ts
const reviewPacketArtifact = await buildReviewPacketArtifact({
  issue,
  target,
  branchName: builderBranch,
  worktreePath,
  baseRef,
  logger,
});

artifacts: [
  buildRunContextArtifact(...),
  reviewPacketArtifact,
]
```

### 4. Update Reviewer Prompt Path Guidance

Import `REVIEW_PACKET_PATH_IN_WORKTREE` where prompt is built.

In `buildReviewerPrompt()` append or include:

```markdown
## Review Packet

Start with the runner-generated Review Packet for changed-file discovery: .pourkit/.tmp/review-packet.md

Treat the Review Packet as discovery context only. Full source, full diffs, tests, and the current Worktree remain source of truth.
```

Also update `.pourkit/prompts/reviewer.prompt.md` required inspection section so agent behavior changes even if prompt template is inspected independently.

### 5. Keep Prior Artifacts Unchanged

Do not summarize prior Reviewer or Refactor artifacts in this change.

Reason:

- Current Reviewer protocol depends on `## Prior Refactor Artifacts` being present when prior refactor artifacts are injected.
- `validateReviewArtifact()` requires `## Prior Refactor Response Assessment` when prior Refactor artifacts were provided.
- Summarizing prior artifacts could break finding lineage or response assessment behavior.

Future work may add compact finding lineage, but not in first implementation.

### 6. Update Domain Docs

Update `.pourkit/CONTEXT.md` with Review Packet glossary term and relationship from this plan.

No ADR.

Rationale for no ADR:

- Change is not hard to reverse.
- Existing ADR-0007 already captures artifact authority and Reviewer independence.
- Review Packet is a straightforward runner-generated discovery aid rather than a durable architectural tradeoff.

## Tests

Prefer real temp Git repo integration tests for packet generation. This feature’s correctness is mostly Git semantics, so mocked Git output is insufficient for core confidence.

Suggested test file:

```text
pourkit/shared/review-packet.test.ts
```

Test setup guidance:

- Create temp repo.
- Configure user name/email if commits are needed.
- Create an initial branch and bare or local remote as `origin` if needed.
- Ensure `origin/<baseBranch>` exists for merge-base tests.
- Use real Git commands to create committed delta, dirty tracked changes, and untracked files.

Core tests:

1. Builds packet with aggregate Review Scope from base to dirty Worktree.
2. Includes committed branch delta when HEAD has commits after merge base.
3. Includes dirty Worktree delta for tracked modifications.
4. Includes untracked files in `## Changed Files` and `## Untracked Files`.
5. Combines repeated path sources into one Changed Files row.
6. Marks binary files using `git diff --numstat --no-renames <mergeBase>` if feasible.
7. Renders loud empty-diff markers and inspection warning when no tracked or untracked changes exist.
8. Fails closed when base ref is missing.
9. Fails closed when merge-base fails.
10. Tolerates untracked listing failure only if practical to simulate without overengineering.

Review command tests:

- Update `pourkit/commands/review.test.ts` to assert Reviewer execution receives both Run Context and Review Packet artifacts.
- Assert artifact path is `.pourkit/.tmp/review-packet.md`.
- Assert prompt references `.pourkit/.tmp/review-packet.md`.
- Assert `baseRef` is passed into packet builder path where feasible, or covered through integration around review loop.

Prompt tests:

- If prompt content is asserted in existing tests, update expected content to include Review Packet guidance.
- If no prompt test exists, add small assertion around `buildReviewerPrompt()` output if function export visibility allows; otherwise assert via `FakeExecutionProvider.lastOptions.prompt`.

## Validation Commands

Run after implementation:

```bash
npm run typecheck
npm run test:agent -- --run
npm run prettier:check
```

Also run targeted tests while developing, for example:

```bash
npm run test:agent -- --run pourkit/shared/review-packet.test.ts
npm run test:agent -- --run pourkit/commands/review.test.ts
```

Use actual package scripts present in repository if names differ.

## Non-Goals

- No full diff hunks in Review Packet.
- No packet use by Refactor in first implementation.
- No prior Reviewer/Refactor artifact summarization in first implementation.
- No token usage telemetry unless provider already exposes reliable usage data.
- No extra fetch during packet generation.
- No generated/lock/large file filtering from packet summaries.
- No staging model changes.
- No intermediate commits for token efficiency.

## Risks And Mitigations

Risk: Reviewer treats packet as source of truth.

Mitigation: Prompt and packet explicitly state packet is discovery context only; source/diff/tests remain source of truth.

Risk: Packet misses untracked files.

Mitigation: Include `git ls-files --others --exclude-standard`, `git status --short`, and union untracked paths into Changed Files.

Risk: Packet uses stale base ref.

Mitigation: Use base ref synced by existing Issue run setup; fail if base ref missing. Do not silently fallback to local branch.

Risk: Packet command failure causes review run to stop.

Mitigation: Intentional fail-closed behavior for required diff context. Missing or partial packet could cause false PASS.

Risk: Packet grows too large on big changes.

Mitigation: No full hunks; summaries only. Generated/lock files are listed but not expanded.

Risk: Tests overfit exact markdown.

Mitigation: Stable headings and key-line assertions; avoid requiring exact full packet string unless necessary.

Risk: Prior artifact protocol breaks.

Mitigation: Leave prior artifact injection unchanged.

## Acceptance Criteria

- Reviewer execution writes `.pourkit/.tmp/review-packet.md` before each Reviewer iteration.
- Packet includes issue summary, diff base, changed files, aggregate Review Scope, committed branch delta, dirty Worktree delta, untracked files, Git status, and inspection guidance.
- Changed Files includes tracked and untracked paths with combined source/status markers.
- Packet includes binary marker from numstat when applicable.
- Packet contains no full diff hunks.
- Packet generation uses `baseRef` from Issue run when available and does not fetch.
- Packet generation fails closed on missing base ref, merge-base failure, or required diff/status command failure.
- Reviewer prompt instructs agent to start with Review Packet but verify source/diff/tests directly.
- Empty Review Scope is allowed but loudly warned in packet and prompt.
- Prior Reviewer/Refactor artifact behavior remains unchanged.
- `.pourkit/CONTEXT.md` defines Review Packet and relationship.
- Tests cover packet generation with real temp Git repo semantics.
- Typecheck, tests, and prettier check pass.

## Suggested Next Workflow

Use `to-prd` to publish a PRD based on this handoff.

After PRD/issues exist, use `tdd` for implementation because Review Packet correctness depends on Git semantics and should be developed test-first.

Use `code-review` after implementation to verify Reviewer behavior, source-of-truth boundaries, and prompt scope.

# Review Packet Token Efficiency Handoff

## Focus

Design and implement a token-efficiency improvement for the Pourkit Reviewer by introducing a compact runner-generated review packet. The goal is to reduce repeated, broad context reads during review/refactor loops while preserving reviewer correctness and independence.

## Current Behavior

- Reviewer prompt is built in `pourkit/commands/review.ts` by `buildReviewerPrompt()`.
- Reviewer runs as `pourkit-reviewer` from `opencode.json` with `permission.task: "deny"`, so it cannot spawn subagents.
- Runner writes `.pourkit/.tmp/run-context.md` using `buildRunContextArtifact()` in `pourkit/shared/run-context.ts`.
- Reviewer run context includes issue details, comments, branch info, verification commands, review criteria names, and artifact paths.
- Reviewer prompt instructs the agent to inspect the current git diff and directly touched files, but the runner does not currently precompute or inline the changed-file list or diff summary.
- Later iterations may include prior reviewer and refactor artifacts in the prompt via `renderPriorReviewerArtifacts()` and `renderPriorRefactorArtifacts()`.

## Relevant Files

- `.pourkit/prompts/reviewer.prompt.md`
- `.pourkit/prompts/reviewer-correctness.snippet.md`
- `.pourkit/prompts/reviewer-scope.snippet.md`
- `.pourkit/prompts/reviewer-tests.snippet.md`
- `.pourkit/prompts/reviewer-quality.snippet.md`
- `pourkit/commands/review.ts`
- `pourkit/shared/run-context.ts`
- `pourkit/execution/sandcastle-execution.ts`
- `opencode.json`
- `.pourkit/strategy.ts`

## Recommended Change

Add a runner-generated review packet, likely at:

`.pourkit/.tmp/review-packet.md`

The packet should give the reviewer a compact starting point before it decides which files to inspect deeply.

Suggested contents:

- Issue number, title, and concise issue metadata already available to the runner.
- Changed file list relative to the base branch.
- Diffstat.
- Name-status summary.
- Verification commands and latest verification result summaries if available in the current workflow state.
- Prior review/refactor summary on later iterations, ideally open findings and finding lineage rather than full artifact bodies.
- A note that full source, full diffs, and full prior artifacts remain available on disk and should be read selectively when needed.

## Prompt Guidance Changes

Update `.pourkit/prompts/reviewer.prompt.md` and `buildReviewerPrompt()` so the reviewer:

- Reads `.pourkit/.tmp/run-context.md` for issue and branch context.
- Starts with `.pourkit/.tmp/review-packet.md` for changed-file and diff summary context.
- Prefers diff hunks and targeted file reads over whole-file reads.
- Avoids reading generated files, lockfiles, or large files unless they are directly relevant to correctness or scope.
- Treats prior artifacts as historical context, not source of truth.
- Still independently verifies the current worktree before issuing findings.

## Design Preference

Keep the shared worktree dirty through the review/refactor loop. Do not introduce commits between review/refactor iterations solely for token efficiency.

Rationale:

- Dirty worktree keeps `git diff` as the simple source of truth for the candidate implementation.
- Refactor can make targeted edits without history rewriting or intermediate commit noise.
- Review/refactor artifacts already preserve iteration history.
- If crash-resume durability is needed, prefer runner-owned patch/diff snapshots under `.pourkit/.tmp/` over intermediate commits.

## Implementation Notes

- The current prompt is saved under `.pourkit/.tmp/prompts/reviewer-iteration-N-<timestamp>.md` by `savePromptToFile()` in `pourkit/execution/sandcastle-execution.ts`; use this to inspect before/after prompt size.
- `RUN_CONTEXT_PATH_IN_WORKTREE` is defined in `pourkit/shared/run-context.ts`; consider adding a similar constant for the review packet path.
- The review packet should be written as an `ExecutionArtifact` alongside the run-context artifact in `runReviewCommand()`.
- Keep the first implementation minimal: changed files, diffstat, name-status, and instructions may be enough before adding prior-artifact summarization.
- Be careful not to make the packet the reviewer’s only source of truth. It should reduce discovery tokens, not replace independent review.

## Suggested Validation

- Add unit tests around packet rendering and artifact injection.
- Add or update reviewer prompt tests in `pourkit/shared/config.test.ts` or relevant command tests if prompt content is asserted there.
- Run `npm run typecheck`.
- Run `npm run test:agent -- --run`.
- Run `npm run prettier:check`.

## Suggested Next Skill

- Use `tdd` if implementing this change test-first.
- Use `code-review` after implementation to check reviewer behavior and prompt scope.

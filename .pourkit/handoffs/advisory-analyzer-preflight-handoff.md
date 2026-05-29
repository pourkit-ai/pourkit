# Handoff: Advisory Analyzer for Builder and Refactor

## Goal

Add a bounded advisory analysis step to the Builder and Refactor stages in Pourkit without changing the deterministic official review loop.

The new step is called **Advisory Analyzer** in Pourkit language. It is a hidden OpenCode subagent used only by the Builder and Refactor primary agents. It is advisory only and produces no artifacts on disk.

The official Reviewer remains the authoritative review role and continues to produce the only review artifacts consumed by Refactor and later workflow stages.

## What Was Agreed

1. This should be implemented as a prompt/config + orchestration change, not as a new top-level workflow stage.
2. The domain term should be **Advisory Analyzer**, not “preflight reviewer”, to avoid overloading the existing **Reviewer** role in `.pourkit/CONTEXT.md`.
3. The project should have a local `opencode.json`.
4. Pourkit should migrate its default agent names to prefixed names:
   - `pourkit-builder`
   - `pourkit-reviewer`
   - `pourkit-refactor`
   - `pourkit-pr-description`
5. The Advisory Analyzer should be a hidden OpenCode subagent named `advisory-analyzer`.
6. The Advisory Analyzer prompt should live in `.pourkit/prompts/advisory-analyzer.prompt.md` and be loaded via OpenCode’s `{file:...}` prompt support.
7. Only Builder and Refactor may invoke the Advisory Analyzer.
8. Builder and Refactor should get strict task permissions allowing only `advisory-analyzer`; Reviewer and PR Description should deny task invocation.
9. The Advisory Analyzer should be read-only, with edits denied and bash denied by default.
10. The Advisory Analyzer should not write artifacts.
11. The Advisory Analyzer should use its own output token namespace, not official reviewer verdict tokens.
12. Refactor Artifact should gain an optional Advisory Analyzer response section so Refactor can record how advisory findings were handled.
13. Update docs with a glossary entry and an ADR.

## Important Repo Facts

These were verified during exploration:

- `.pourkit/prompts/builder.prompt.md` and `.pourkit/prompts/refactor.prompt.md` already hold stage prompts.
- `.pourkit/strategy.ts` defines the current repo-local default strategy and still uses agent names like `build`, `review`, `refactor`, and `pr-description`.
- `pourkit.config.ts` and `pourkit.config.example.ts` also define those older names.
- `pourkit/commands/init.ts` emits the managed default config with the same older names.
- `pourkit/execution/sandcastle-execution.ts` currently hardcodes `opencode(model, { env, agent: "build" })` instead of passing the configured stage agent.
- OpenCode config schema supports:
  - `agent.<name>.mode`
  - `agent.<name>.hidden`
  - `agent.<name>.prompt`
  - `agent.<name>.model`
  - `agent.<name>.permission`
  - `agent.<name>.task` permissions
  - prompt file loading with `prompt: "{file:...}"`
- The repo already has `.pourkit/CONTEXT.md` and `.pourkit/docs/adr/`.

## Design Boundary

Do **not** add a new deterministic preflight stage in the runner.

The desired shape is:

- Builder implements the issue.
- Builder runs verification.
- Builder invokes Advisory Analyzer up to a bounded number of times.
- Builder fixes accepted advisory findings.
- Builder reruns relevant verification.
- Builder completes.

And similarly for Refactor:

- Refactor reads the latest official Reviewer output.
- Refactor classifies official findings.
- Refactor fixes accepted official findings.
- Refactor runs verification.
- Refactor invokes Advisory Analyzer up to a bounded number of times.
- Refactor fixes accepted advisory findings.
- Refactor reruns relevant verification.
- Refactor writes the Refactor Artifact.
- Official Reviewer remains canonical and continues the review loop.

The Advisory Analyzer should be conversational input to Builder/Refactor only. It should not become a source of truth, should not parse as an official verdict, and should not write files.

## Finalized Decisions

### Naming

- Domain term: `Advisory Analyzer`
- OpenCode subagent name: `advisory-analyzer`
- Do not use `preflight` as the primary domain noun in docs or glossary.

### OpenCode Layout

Create or update project-local `opencode.json` at the repo root.

Primary agents:

- `pourkit-builder`
- `pourkit-reviewer`
- `pourkit-refactor`
- `pourkit-pr-description`

Subagent:

- `advisory-analyzer`

The project-local OpenCode config should define these agents directly.

Use the Pourkit prompt file as the canonical prompt text for the Advisory Analyzer, and reference it from OpenCode with:

`prompt: "{file:.pourkit/prompts/advisory-analyzer.prompt.md}"`

### Visibility

- `advisory-analyzer` should be `hidden: true`
- It remains invokable by the primary agents via Task permissions.

### Permissions

Advisory Analyzer permissions should be strictly read-only:

- `edit: deny`
- `task: deny`
- `bash`: deny by default with a narrow allowlist only if needed for inspection/validation
- read/search tools allowed

Builder and Refactor task permissions:

- `task: { "*": "deny", "advisory-analyzer": "allow" }`

Reviewer and PR Description task permissions:

- `task: "deny"`

### Advisory Analyzer Output

Use advisory tokens, not official verdict tokens:

- `<advisory>PASS</advisory>`
- `<advisory>FIX_RECOMMENDED</advisory>`
- `<advisory>NEEDS_HUMAN</advisory>`

Never emit `<verdict>...</verdict>` from the Advisory Analyzer.

### Loop Boundaries

The agreed limit is:

- maximum **3** Advisory Analyzer calls per Builder stage execution
- maximum **3** Advisory Analyzer calls per Refactor stage execution

This is intentionally bounded. It is not a free-running review loop.

### Artifacts

- Advisory Analyzer writes no artifacts.
- Builder/Refactor consume the analyzer’s conversational output directly.
- Only the official Reviewer stage continues to write official review artifacts.
- Refactor Artifact should include an optional section for Advisory Analyzer responses so Refactor can document how advisory findings were handled.

## Files Likely To Change

### Prompt / Config

- `opencode.json`
- `.pourkit/prompts/advisory-analyzer.prompt.md`
- `.pourkit/prompts/builder.prompt.md`
- `.pourkit/prompts/refactor.prompt.md`

### Orchestration

- `pourkit/execution/sandcastle-execution.ts`
- `pourkit/commands/issue-run.ts`
- `pourkit/commands/review.ts`
- `pourkit/shared/config.ts`
- `pourkit/shared/run-context.ts` if run context sections need extension

### Default Config / Init

- `.pourkit/strategy.ts`
- `pourkit.config.ts`
- `pourkit.config.example.ts`
- `pourkit/commands/init.ts`

### Docs

- `.pourkit/CONTEXT.md`
- `.pourkit/docs/adr/<new-adr>.md`

### Tests

- `pourkit/commands/issue.test.ts`
- `pourkit/commands/review.test.ts`
- `pourkit/shared/config.test.ts`
- `pourkit/shared/run-context.test.ts` if new sections are added
- Any Sandcastle/OpenCode config tests that assert stage agent wiring

## Implementation Sequence

### 1. Add the Advisory Analyzer prompt

Create `.pourkit/prompts/advisory-analyzer.prompt.md`.

The prompt should:

- state that it is a cheap advisory analysis step
- explicitly state that it is not the official Reviewer
- forbid file edits
- forbid official verdict tokens
- use the advisory output token set above
- focus on scoped, concrete, actionable findings only
- suppress broad cleanup, style-only churn, speculative refactors, and unrelated repo review
- include the “read-only, advisory-only, no artifacts” rule

The prompt should be concise enough to be usable as a system prompt but detailed enough to keep the analyzer narrow.

### 2. Add or update project-local `opencode.json`

Use the OpenCode schema rather than guessing. The config should define:

- the four primary Pourkit agents as `primary`
- `advisory-analyzer` as `subagent`
- `hidden: true` on the analyzer
- `prompt: "{file:.pourkit/prompts/advisory-analyzer.prompt.md}"`
- strict read-only permissions for the analyzer
- `task` permissions on `pourkit-builder` and `pourkit-refactor` allowing only `advisory-analyzer`

Because OpenCode config is project-local and validated at startup, remember that config changes require restarting OpenCode for them to take effect.

### 3. Stop hardcoding `build` in Sandcastle execution

`pourkit/execution/sandcastle-execution.ts` currently constructs OpenCode with `agent: "build"`.

That must be changed so the configured stage agent is actually used. Otherwise the project-local agent names will never matter.

Target outcome:

- Builder stage uses configured Builder agent
- Refactor stage uses configured Refactor agent
- Reviewer stage uses configured Reviewer agent
- Finalizer stage uses configured PR description agent

### 4. Migrate the default Pourkit agent names

Update the repo defaults so the generated/checked-in config uses prefixed agent names:

- Builder -> `pourkit-builder`
- Reviewer -> `pourkit-reviewer`
- Refactor -> `pourkit-refactor`
- PR description -> `pourkit-pr-description`

Touch at least:

- `.pourkit/strategy.ts`
- `pourkit.config.ts`
- `pourkit.config.example.ts`
- `pourkit/commands/init.ts`

Keep the schema generic so downstream users with custom names are not forced into a breaking rename.

### 5. Update Builder prompt

Add a dedicated Advisory Analyzer section after implementation and verification but before completion.

Required Builder prompt behavior:

- use the cheapest effective search strategy first
- keep exploration bounded to the selected issue
- invoke `pourkit-builder`’s Advisory Analyzer support explicitly
- provide issue requirements, current diff, files changed, verification results, and assumptions/limitations
- accept only concrete scoped findings
- reject speculative, broad, or stylistic findings
- rerun relevant verification after accepted fixes
- keep a hard cap of 3 analyzer calls

Completion requirements should include:

- `Assumption check: pass` or `Assumption check: mismatch`
- advisory result summary
- verification commands run and results

### 6. Update Refactor prompt

Add an Advisory Analyzer section after accepted official reviewer fixes and verification, but before writing the Refactor Artifact or completing.

Required Refactor prompt behavior:

- read latest official Reviewer output first
- classify official findings and only edit for accepted findings
- run verification after official-finding fixes
- invoke Advisory Analyzer with the current diff and verification context
- only accept advisory findings that are directly related to accepted official findings, regressions introduced by refactor changes, obvious verification/build/test failures, or unresolved selected-issue gaps
- reject scope expansion, contradictions without evidence, broad cleanup, speculative design changes, and anything not actionable in a small edit
- allow up to 3 analyzer calls total
- record Advisory Analyzer responses in the Refactor Artifact

### 7. Extend Refactor Artifact structure

The Refactor Artifact currently has structured sections and is validated by `validateRefactorArtifact` in `pourkit/commands/review.ts`.

Add an optional section like:

```md
## Advisory Analyzer Responses

| Advisory Finding ID | Classification | Rationale | Files Changed |
|---------------------|----------------|-----------|---------------|
```

Use classifications such as:

- `accepted`
- `rejected`
- `deferred`
- `blocked`

Because the analyzer itself writes no artifact, Refactor is the only place that should persist these responses.

### 8. Keep official verdict parsing isolated

The official review parser in `pourkit/pr/review-verdict.ts` must continue to look only for official `<verdict>...</verdict>` tokens.

Do not let Advisory Analyzer output be parsed as a review verdict.

If there is any log recovery / artifact parsing path that scans text generically, make sure it remains scoped to official reviewer artifacts only.

Add a defensive test if useful:

- Advisory Analyzer output containing `<advisory>FIX_RECOMMENDED</advisory>` must not be interpreted as an official reviewer verdict.

### 9. Update tests

At minimum, add coverage for:

- Builder prompt contains `Advisory Analyzer`
- Builder prompt references `advisory-analyzer`
- Builder prompt says the analyzer is advisory only
- Builder prompt caps analyzer calls at 3
- Refactor prompt contains `Advisory Analyzer`
- Refactor prompt says analyzer cannot override official Reviewer output
- Refactor prompt caps analyzer calls at 3
- Advisory prompt contains `<advisory>` tokens
- Advisory prompt does not contain `<verdict>` tokens
- OpenCode config defines hidden analyzer and the four prefixed primaries
- Builder/Refactor task permissions allow only `advisory-analyzer`
- Reviewer/PR description cannot invoke `advisory-analyzer`
- Sandcastle execution uses the configured stage agent instead of hardcoded `build`
- Refactor Artifact validation still accepts the existing official sections plus the new optional advisory section

### 10. Update docs

Update `.pourkit/CONTEXT.md` with the new domain term.

Suggested glossary entry shape:

- **Advisory Analyzer**: a hidden, non-authoritative subagent used by Builder and Refactor to catch concrete scoped defects before completion. It produces advisory output only and never decides issue completion.

Add an ADR because this is a meaningful architecture decision:

- project-local OpenCode agent identities
- hidden subagent for bounded advisory analysis
- deterministic Reviewer authority remains unchanged

## Likely Risks

### 1. Hardcoded agent name prevents config from mattering

The current Sandcastle execution path hardcodes `build`.

Fixing that is mandatory.

### 2. Advisory Analyzer accidentally becomes a shadow reviewer

Keep the analyzer strictly scoped:

- advisory only
- no artifacts
- no official verdict tokens
- no authority over completion
- no broad architecture/style cleanup

### 3. Loop becomes effectively unbounded

The analyzer should have a hard call cap of 3 per stage execution.

### 4. Config shape mismatch with OpenCode schema

Validate against the schema before writing `opencode.json`.

The schema supports `prompt: "{file:...}"`, `mode`, `hidden`, `permission`, and `task` permissions.

### 5. Official review parsing gets confused

Official review parsing must remain isolated to official review artifacts / tokens only.

### 6. Existing custom configs may use old agent names

The default repo config should migrate, but schema and config handling should remain generic so downstream custom configurations are not broken unnecessarily.

## Suggested Skills For Next Session

- `tdd`
- `customize-opencode`
- `security-review` if any permissions or shell allowances change materially

## Files Read In Discovery

Useful context from this pass:

- `.pourkit/CONTEXT.md`
- `.pourkit/docs/adr/0007-structured-refactor-artifacts-and-human-handoff-verdict.md`
- `.pourkit/docs/adr/0008-sandbox-execution-around-resumable-worktrees.md`
- `.pourkit/docs/adr/0003-managed-bootstrap-assets-and-local-customization.md`
- `.pourkit/prompts/builder.prompt.md`
- `.pourkit/prompts/refactor.prompt.md`
- `pourkit/execution/sandcastle-execution.ts`
- `pourkit/execution/deterministic-agent.ts`
- `pourkit/commands/review.ts`
- `pourkit/pr/review-verdict.ts`
- `pourkit/shared/config.ts`
- `pourkit/commands/issue-run.ts`
- `pourkit/commands/init.ts`
- `pourkit.config.ts`
- `pourkit.config.example.ts`
- `.pourkit/strategy.ts`

## Current Status

No implementation changes were made yet in this handoff pass. This document is the starting point for the coding agent.

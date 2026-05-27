---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

The issue tracker and triage label vocabulary should have been provided to you — run /setup-matt-pocock-skills if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

If the source material references existing behavior, previous issues, ADRs, tests, workflows, labels, config keys, or public interfaces, treat those as regression-sensitive until proven otherwise.

If the source material depends on choosing one value from many external candidates (for example tags, files, labels, config roots, or migration records), treat the candidate set, ordering rule, validity rule, and fallback behavior as regression-sensitive until they are explicit in the source material.

### 2. Explore the codebase

Use semantic/code-intel tools when they are available to identify which files and directories are relevant to the plan. Trace imports and symbol relationships to understand the code paths involved.

If semantic tools are unavailable, fall back to `grep`/`glob`/`read` to trace code paths manually. Mark every inferred code path entry with `[inferred, not semantically verified]` so the builder knows to double-check.

Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

While exploring, identify existing tests near the touched code paths. Prefer issues that extend existing test coverage instead of creating isolated tests disconnected from current behavior.

### 3. Draft vertical slices

Break the plan into tracer bullet issues. Each issue is a thin vertical slice for one independently reviewable behavior contract. It may cut through multiple adjacent layers needed for that behavior, but it must not bundle unrelated contracts merely because they share a dependency, directory, package, integration boundary, or migration theme.

Slices must be AFK. AFK slices can be implemented and merged without human interaction. They must be as slim as possible for cheaper coding models to handle.

AFK slices must have no unresolved decisions. Planner uncertainty is allowed only when it is explicitly assigned to the builder to verify from code, tests, ADRs, or existing artifacts. Do not leave product intent, workflow semantics, or contract selection for the builder to decide.

#### 3a. Decompose by independently reviewable behavior contract

Before drafting issue bodies, identify the behavior contracts in the source material.

A behavior contract is one externally visible outcome that a reviewer can pass/fail without also reviewing unrelated workflows. It may be a user-facing workflow, a public interface contract, a state transition, an integration boundary, a persistence behavior, a validation rule, an error-handling contract, or an enforcement/guardrail behavior.

Do not group behavior contracts together merely because they share:

- the same dependency migration
- the same library or tool
- the same directory or package
- the same architectural layer
- the same PRD/spec section
- the same broad theme

For migration/refactor PRDs, “replace X with Y” is not automatically one issue. Split by externally visible contract first, then by dependency order.

Each proposed issue must pass the contract-isolation test:

> Could a reviewer approve or reject this issue by evaluating one primary behavior contract?

If no, split the issue.


For each slice, infer code paths using semantic tools (or `grep`/`glob` if unavailable). Trace symbol relationships and imports to predict which files the implementation will touch. This produces a rough dependency chain, for example:

schema.ts -> repository.ts -> service.ts -> handler.ts

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer needed for that behavior.
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over few thick slices.
- Target one primary behavior contract per issue.
- Prefer 1–3 closely related user stories per issue. Allow 4 only when all stories share the same public method family, test fixture, and workflow outcome.
- Do not require strict one-user-story-per-issue mapping; group stories only when they prove the same behavior contract.
- Split the issue if it touches more than one unrelated integration boundary, command workflow, persistence workflow, or state machine outcome.
- Split the issue if it requires changes to more than two major production modules, unless those modules are adjacent layers of the same behavior path.
- Split the issue if it requires changes to more than two test suites.
- Split the issue if the acceptance criteria mention unrelated workflows joined by "and". Multiple criteria are acceptable only when they all verify the same primary behavior contract.
- A dependency migration is not a valid slice boundary by itself. The slice boundary is the user-visible or maintainer-visible behavior contract preserved or introduced by the migration.
- Include inferred code paths for each slice so implementing agents know where to look.
- Each slice must include at least one regression-sensitive behavior to preserve when existing behavior is touched.
- Do not create slices that only add tests unless the PRD explicitly asks for test coverage or regression coverage.
- If the change depends on selecting one result from many candidates, the slice must name the candidate set, the ordering rule, the validity rule, and what happens when an invalid newer candidate would otherwise mask a valid older one.
</vertical-slice-rules>

### 4. Generate the issues for each slice

Use this template for every issue. Every section is mandatory. Do not omit any section, even if the content is "None identified."

<issue-template>

## Parent

A reference to the parent issue on the issue tracker, if the source was an existing issue. Omit this section if there is no parent issue.

## Source of truth for behavior

Name the authority that defines the behavior for this issue. Use one or more of: code, ADR, context glossary, issue comment, existing test, explicit new contract.

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

## Affected code paths

List the planned files this slice will touch. You MUST include specific symbols. If a code path was inferred without semantic tools, append `[inferred]` to the file path.

- full/path/file.ext
  - Class/Module: Name
  - Functions/Methods: methodName(...)
  - New: Yes/No

## Current behavior

Max 3 bullets. Be specific — name the function, the config key, or the observable output.

- What the code does today.
- What is missing, incorrect, or incomplete.
- Existing pattern/convention to preserve.

## Desired behavior

Max 3 bullets. Be specific — name the expected input, output, or state change.

- New behavior this slice adds or changes.
- Expected inputs/outputs/state changes.
- Compatibility expectations.

## Contract decisions

Required for issues touching workflow control, state, verdicts, labels, artifacts, file paths, or public result shapes. List every decision the builder must not have to invent.

- Decision: ...
- Source of truth: code / ADR / context glossary / issue comment / existing test / explicit new contract

If this issue does not touch those areas, write: None — no contract decisions needed.

## Regression contract (CRITICAL)

List existing behavior that must remain true after this issue. Every issue must include at least one bullet.

Each bullet must use this format exactly:

- Existing behavior:
  - What currently works: [specific observable behavior, not "existing behavior works"]
  - Why it is at risk: [which code path this change touches that could accidentally affect it]
  - Test that protects it: [name of existing test, or description of the regression test to add]
  - Must not change: [specific public interface, label, file path, or output]

Rules:
- Do not write vague statements like "preserve existing behavior" or "tests should pass." Name the behavior.
- Never use hedging language like "strengthen or add" in the Test that protects it field. Either name an existing test by its description string, or write a concrete description of the new regression test to add. If you are uncertain which test exists, write "Planner uncertainty: unknown whether a test for X exists — builder must check and add if missing" rather than hedging.
- If the slice only adds brand-new behavior with no existing behavior at risk, write:
  - Existing behavior:
    - What currently works: No existing behavior is directly changed.
    - Why it is at risk: None identified after code-path review.
    - Test that protects it: Existing test suite for the nearest touched path should continue to pass.
    - Must not change: Public interfaces and unrelated behavior.
- If the issue touches failure handling, parsing, config loading, command execution, labels, file paths, public types, provider calls, persistence, migrations, or cleanup logic, the regression contract must name the closest old behavior that could break.
- If the issue touches command execution, file paths, repo roots, CLI parsing, or framework-managed routing, the regression contract must name the exact execution context or invocation that must still behave normally (for example `cwd`, `POURKIT_ROOT`, or a concrete subcommand invocation).
- If an acceptance criterion depends on stateful behavior over time such as `once`, `per run`, deduplication, caching, resume, retry, reset, or suppression, the regression contract must define the state boundary: what scope shares the state, what resets it, what persists across retry or resume, and what must not persist into a distinct new run.
- If the issue validates against a known standard or format, the regression contract must state whether full compatibility is required or only a repo-specific subset.
- **Migration/refactor slices only:** For every field, property, or pattern being removed, add a regression contract bullet that names it explicitly — including its exact field name, the file it appears in, and the fixture or call site that currently authors it. Do not describe removals only in prose. Name them.

## Step-by-step implementation

Prefer 4–7 steps. If the slice genuinely requires more steps to be concrete, use more rather than collapsing two actions into one vague step. Vagueness is worse than length.

Each step must use this format:

1. path/file.ext / symbolName(...)
   - Action: add / modify / delete / add test
   - Given: Existing condition or input state.
   - When: The changed code path runs.
   - Then: Expected observable behavior/output.
   - Notes: Concrete implementation detail.
   - Constraints: What must not change.

Rules:
- At least one step must be a regression test for the behavior named in Regression contract.
- Regression tests must prove old behavior still works, not only that new behavior works.
- Test steps should come before implementation steps when behavior is clear.
- Fixture setup and helper changes that exist to support test steps count as test-supporting steps and must also come before implementation steps.
- If an issue touches failure handling, parsing, config loading, command execution, labels, file paths, public types, provider calls, persistence, migrations, or cleanup logic, include a regression test for the closest existing behavior.
- If an issue requires user-facing signaling around setup, fallback, or other prerequisite work, specify whether that signal must still occur when the dependent operation fails, and include a failing-path test when the answer is yes.
- Do not include vague steps like "support the new shape" or "update the handler."
- Do not include broad exploration steps like "inspect the codebase."
- Do not include steps that require human judgment during implementation.
- Do not write conditional steps. A step must not contain "only if", "if it is already", "if applicable", or equivalent phrases that require the builder to make a decision. If the planner is uncertain, write "Planner uncertainty: ..." on its own step rather than embedding a branch inside another step.
- Do not require the builder to open unrelated files unless they are in Affected code paths.
- If exact contracts, signatures, config keys, enum values, or result shapes are needed, put them in Contracts / interfaces rather than inline here.
- If the planner is uncertain about a detail, write "Planner uncertainty: ..." rather than inventing a detail.
- **One file per step.** A step must reference exactly one file path. If two files need the same kind of change, write two steps — one per file. Never bundle multiple files into a single step with "and" or a comma-separated list. This applies to test files, fixture helpers, and implementation files equally.
- For test steps, include a short code sketch of the key assertion when the expected value is non-obvious. Do not write the full test body — just enough to eliminate ambiguity about what "passing" looks like.
- **Any step whose Action is `modify` on a test file must include a code sketch of at least one assertion.** Test modifications are the highest-risk place for vagueness — "add negative assertions" without showing one is not sufficient.
- For implementation steps, include a short code sketch when the wiring or call site pattern would take more than one sentence to describe unambiguously. Keep sketches to 2–5 lines. Do not write the full implementation.
- Do not add code sketches where prose is already unambiguous — sketches should resolve ambiguity, not restate it in code.
- **Migration/refactor slices only:** For every field, property, fixture helper, or call site being removed or replaced, include an explicit deletion step that names the exact field and file. Do not describe removals only in prose in What to build or Desired behavior — they must appear as concrete steps. At least one test step must include a negative assertion that would fail if the legacy field were still present after the change.

**Example of a negative assertion for a migration step:**
```ts
// Must fail if legacy field is still authored
expect(fixture).not.toHaveProperty("verificationCommands");
expect(fixture.targets[0]).not.toHaveProperty("verificationCommands");
```

**Example of a test step with a useful code sketch:**

2. pourkit/commands/issue.test.ts / "verification failure returns correct result shape"
   - Action: add test
   - Given: strategy.verify.commands contains a command that exits 1.
   - When: verifyIssue() runs.
   - Then: resolves with `{ ok: false, exitCode: 1 }`.
   - Notes: Use the existing failed-command fixture.
   - Constraints: Do not assert on the reason string — it is not yet standardized.
   ```ts
   expect(result).toMatchObject({ ok: false, exitCode: 1 });
   ```

**Example of an implementation step with a useful code sketch:**

4. pourkit/commands/issue.ts / runWorkflow()
   - Action: modify
   - Given: verifyIssue() returns `{ ok: false }`.
   - When: the verify result is checked.
   - Then: the existing failure handler is called, not a new code path.
   - Notes: Route through the existing `handleFailure()` rather than throwing directly.
   - Constraints: Do not bypass issue failure transitions.
   ```ts
   const result = await verifyIssue(issueId, strategy.verify);
   if (!result.ok) return handleFailure(issueId, result);
   ```

## Contracts / interfaces

Concrete public shapes the builder needs, expressed as code blocks in the project's actual type system. If nothing applies, write "None."

Use the language that matches the project — TypeScript interfaces, Python TypedDicts/dataclasses, JSON for config contracts, etc. A builder model should be able to copy these directly without inferring shape from prose. Cover function signatures, type shapes, config keys, event names, error/result shapes, enum values, labels, env vars, and any file paths that act as public contracts — whatever is relevant to this slice.

**Example (TypeScript):**
```ts
// New function signature
export async function verifyIssue(
  issueId: string,
  strategy: VerifyStrategy,
): Promise<VerifyResult>;

// Result shape
type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string; exitCode: number };

// Config shape (strategy.verify field)
interface VerifyStrategy {
  commands: string[];
  timeout?: number; // ms, default 30000
}
```

**Example (Python):**
```python
@dataclass
class VerifyResult:
    ok: bool
    reason: str | None = None
    exit_code: int | None = None

def verify_issue(issue_id: str, strategy: VerifyStrategy) -> VerifyResult: ...
```

**Example (JSON config):**
```json
{
  "strategy": {
    "verify": {
      "commands": ["npm test"],
      "timeout": 30000
    }
  }
}
```

Omit sections that don't apply to this slice. No prose explanations alongside the code — the shapes should be self-documenting.

## Edge cases

Max 3 bullets. If none apply, write "None identified."

- Missing/empty input.
- Invalid value.
- Backward compatibility or migration case.

## Validation

Max 4 bullets. At least one must be tied directly to the Regression contract.

- New behavior test:
- Regression contract test:
- Existing command that should still pass:
- Manual/example verification, if relevant:

## Out of scope

Only include this section if there is a realistic risk that a builder would overreach. If the slice has no meaningful overreach risk, write "None — scope is self-contained."

Max 3 bullets if populated:
- Do not change unrelated behavior.
- Do not rename public fields unless explicitly required.
- Do not refactor unrelated files.

## Priority

bugfix / infra / feature / polish / refactor

## Acceptance criteria

Rules:
- At least one criterion must correspond to the new behavior.
- At least one criterion must correspond to the Regression contract.
- Criteria must be observable and verifiable — not "works correctly" but "returns X given Y."

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- Use real issue numbers in #123 format, once blockers are published.
- Or: "None — can start immediately."

</issue-template>

### 5. Adversarial review loop (max 3 passes — do not skip)

Before running the quality checklist, simulate a bad-faith implementation of the issue. Ask yourself: "How could a builder model follow these steps exactly and still fail a code review?" This is not a confirmation pass — it is an attempt to break the issue.

For each issue, work through these hostile questions in order:

0. **The theme-sized issue test.** Is this issue grouped by a broad theme, dependency, directory, package, or PRD/spec heading rather than one independently reviewable behavior contract? Red flags include:

   - The issue combines unrelated integration boundaries.
   - The issue combines separate workflow outcomes that can be reviewed independently.
   - The issue combines implementation-layer migration and higher-level workflow coordination.
   - The issue combines runtime behavior with documentation, operational, or enforcement work.
   - The issue has more than 3 regression contract bullets for different workflows.
   - The issue has acceptance criteria for unrelated workflows.

   If yes, split the issue before continuing. Do not try to fix a theme-sized issue by adding more detail.

1. **The ghost field test.** If a builder implemented every step literally and nothing else, would any legacy field, pattern, or call site that this slice is meant to remove still be present in the codebase? If yes, there is a missing deletion step or the deletion step is not specific enough.

2. **The conditional trap test.** Does any step contain "only if", "if it is already", "if applicable", or any other phrase that requires the builder to make a judgment call? If yes, resolve the uncertainty now or flag it as "Planner uncertainty: ..." — do not leave it for the builder.

3. **The passing-but-wrong test.** Would the negative assertions written in the test steps actually fail on the current codebase before any changes are made? If a negative assertion already passes before the change, it proves nothing. The assertion must fail on the current code and pass only after the legacy field is removed.

4. **The contradiction test.** Does the regression contract say something must not change that a step then changes? Does a step remove something the regression contract does not account for? Any contradiction means the issue will generate conflicting signals for a reviewer — resolve it before publishing.

5. **The coverage gap test.** Is there any behavior named in the acceptance criteria that is not covered by at least one concrete step? If a criterion cannot be traced to a step, add the step or remove the criterion.

6. **The lifecycle boundary test.** If the issue includes stateful behavior over time, could a builder satisfy the prose with the wrong persistence or reset boundary? Could a test pass while modeling the wrong lifetime? If yes, define the boundary explicitly and add a test that distinguishes the correct lifetime from a plausible wrong one.

7. **The contract reference test.** For every type, interface, or shape defined in Contracts / interfaces, is there at least one step that references it by name? If a step introduces a return type, result shape, or call signature inline in prose or a code sketch that matches a type already defined in Contracts / interfaces, flag it — replace the inline definition with an explicit reference to the named type. A builder given two different definitions of the same shape will implement whichever one it reads last.

8. **The ambiguity checklist.** Could a builder and reviewer both reasonably interpret this issue differently? If yes, resolve the ambiguity before publishing by tightening the source of truth, contract decisions, or step wording.

For each problem found, fix the issue body and restart the pass. Repeat for up to 3 passes total.

**If the issue still has unresolved problems after 3 passes**, do not publish it. Surface the remaining problems to the user with a clear description of what is uncertain and ask for clarification before continuing.

### 6. Check issue quality before publishing (CRITICAL — fix before proceeding)

Before publishing each issue, verify every item in this checklist. If any item fails, fix the issue before publishing. Do not publish an issue that fails any item.

<issue-quality-checklist>
- [ ] Small enough for a cheaper builder model to implement without ambiguity.
- [ ] The issue has exactly one primary behavior contract.
- [ ] The issue is not grouped only by theme, directory, package, dependency, or PRD/spec heading.
- [ ] The issue does not combine multiple unrelated integration boundaries unless they are part of one public workflow outcome.
- [ ] The issue does not combine implementation-layer migration with command/workflow coordination unless the lower-level change is only a small adapter for that workflow.
- [ ] The issue touches no more than two major production modules and no more than two test suites, unless the issue explicitly explains why those files are adjacent layers of the same behavior path.
- [ ] The acceptance criteria all verify the same primary behavior contract.
- [ ] Describes end-to-end behavior, not just a layer task.
- [ ] Affected code paths name specific symbols, not just files.
- [ ] Inferred code paths are marked `[inferred]` if semantic tools were unavailable.
- [ ] Current behavior names the specific old behavior or gap, not just "it doesn't work."
- [ ] Desired behavior names the specific new behavior, input, and output.
- [ ] Regression contract names a real observable behavior — not "existing behavior works."
- [ ] Issue body names the source of truth for behavior: code, ADR, context glossary, issue comment, existing test, or explicit new contract.
- [ ] Regression contract contains no hedging language ("strengthen or add", "if applicable", etc.) — every test is either named or written.
- [ ] Step-by-step includes at least one regression test step.
- [ ] Step-by-step contains no conditional steps ("only if", "if it is already", "if applicable") — planner uncertainties are flagged explicitly.
- [ ] AFK issues contain no unresolved decisions; any planner uncertainty is verification-only and assigned to the builder, not a judgment call.
- [ ] Every step references exactly one file — no step bundles multiple files with "and" or a comma-separated list.
- [ ] Every step whose Action is `modify` on a test file includes a code sketch of at least one assertion.
- [ ] No step contradicts the regression contract. If a step removes or changes something, the regression contract must account for it. If the regression contract says something must not change, no step changes it.
- [ ] Validation includes at least one regression contract test.
- [ ] Acceptance criteria include both new behavior and a preserved behavior from Regression contract.
- [ ] Contracts / interfaces contains concrete shapes only — no prose explanations, no access patterns or usage snippets.
- [ ] Issues touching workflow control, state, verdicts, labels, artifacts, file paths, or public result shapes include a populated Contract decisions section.
- [ ] Every type or interface defined in Contracts / interfaces is referenced by name in at least one step. No step defines an inline shape that duplicates or contradicts a named contract type.
- [ ] The issue passes the ambiguity checklist: a builder and reviewer would not reasonably interpret it differently.
- [ ] Out of scope addresses realistic overreach risk, or says "None — scope is self-contained."
- [ ] Blocked by uses real issue numbers in #123 format, or says "None — can start immediately."
- [ ] Every mandatory section is present, even if the content is "None identified."
- [ ] **Migration/refactor slices only:** Every legacy field being removed is named explicitly in both the regression contract and a deletion step — not only described in prose.
- [ ] **Migration/refactor slices only:** At least one test step includes a negative assertion (`not.toHaveProperty`, `not.toHaveBeenCalledWith`, `toThrow`, etc.) that would fail if the legacy field or pattern were still present.
</issue-quality-checklist>

### 7. Publish issues in dependency order

> **Order matters.** Publish blockers first so their issue numbers exist before you reference them in the Blocked by field of dependent issues. Do not publish a dependent issue before its blockers have been assigned real issue numbers.

For each approved slice, publish a new issue using the body generated in step 5.

Apply the `needs-triage` label and the appropriate type label:

- `type:bugfix`
- `type:infra`
- `type:feature`
- `type:polish`
- `type:refactor`

If the slice has blockers (Blocked by is not "None — can start immediately"), also apply the `blocked` label so Pourkit will skip it until its dependencies resolve.

Do NOT close or modify any parent issue.

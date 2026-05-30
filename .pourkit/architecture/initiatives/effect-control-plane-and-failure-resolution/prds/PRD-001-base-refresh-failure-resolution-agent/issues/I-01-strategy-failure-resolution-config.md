# PRD-001 / I-01: Require strategy failure resolution config

## Parent

PRD-001: Base Refresh + Failure Resolution Agent

## Source of truth for behavior

Explicit new contract, DEC-0007, DEC-0008, DEC-0009, existing config schema, existing config tests, context glossary.

## What to build

Replace the public Strategy conflict-resolution config boundary with mandatory `strategy.failureResolution`, including default retry budget and per-failure overrides.

## Affected code paths

- pourkit/shared/config.ts [inferred]
  - Class/Module: ReviewRefactorLoopStrategyInput, ReviewRefactorLoopStrategy, ReviewRefactorLoopStrategySchema, checkRemovedFields(...)
  - Functions/Methods: parseConfig(...), formatZodError(...)
  - New: No
- pourkit/shared/config.test.ts [inferred]
  - Class/Module: config parsing tests
  - Functions/Methods: rawConfig(...), strategy(...), parseConfig(...)
  - New: No
- pourkit/shared/config.typecheck.ts [inferred]
  - Class/Module: config type fixtures
  - Functions/Methods: TypeScript fixture assignments
  - New: No
- pourkit.config.example.ts [inferred]
  - Class/Module: example config
  - Functions/Methods: exported config object
  - New: No

## Current behavior

- `ReviewRefactorLoopStrategySchema` accepts optional `conflictResolution` with `agent`, `model`, `promptTemplate`, and `maxAttempts`.
- `parseConfig(...)` allows Strategies without any conflict or failure resolution section.
- Existing tests assert `strategy.conflictResolution` parses successfully.

## Desired behavior

- Every Strategy must include `strategy.failureResolution` with required agent config and optional `maxAttemptsPerFailure` defaulting to `3`.
- `failureLimits` accepts positive integer overrides keyed by first-slice StageFailure type.
- Any `strategy.conflictResolution` key fails validation with migration guidance to `strategy.failureResolution`.

## Contract decisions

- Decision: `strategy.failureResolution` is required under every Strategy.
- Source of truth: DEC-0008 / explicit new contract
- Decision: `strategy.failureResolution.maxAttemptsPerFailure` defaults to `3`.
- Source of truth: PRD-001 / explicit new contract
- Decision: `strategy.failureResolution.failureLimits` overrides retry budget per StageFailure type.
- Source of truth: DEC-0009 / explicit new contract
- Decision: `strategy.conflictResolution` is removed at the public config boundary.
- Source of truth: DEC-0007 / DEC-0008

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: Strategy agent configs for Builder, Reviewer, Refactor, Verify, and Finalize parse through `parseConfig(...)`.
  - Why it is at risk: `ReviewRefactorLoopStrategySchema` changes the Strategy object shape.
  - Test that protects it: Existing canonical review-refactor-loop strategy parse test must continue to assert Builder, Reviewer, Refactor, Verify, and Finalize fields.
  - Must not change: Existing public Strategy fields other than `strategy.conflictResolution`.
- Existing behavior:
  - What currently works: Removed legacy config fields produce explicit migration errors.
  - Why it is at risk: Adding conflictResolution to removed-field preflight could obscure existing migration messages.
  - Test that protects it: Existing removed-field migration tests in `config.test.ts` must keep their current expected messages.
  - Must not change: Existing migration messages for `config.reviewer`, `config.refactorer`, `config.maxReviewIterations`, and target-level legacy fields.

## Step-by-step implementation

1. pourkit/shared/config.test.ts / "parses strategy with failureResolution section"
   - Action: add test
   - Given: A Strategy includes `failureResolution` with agent config and `maxAttemptsPerFailure: 2`.
   - When: `parseConfig(...)` runs.
   - Then: parsed Strategy exposes `failureResolution` with the agent config and `maxAttemptsPerFailure: 2`.
   - Notes: Use the existing `strategy(...)` fixture style.
   - Constraints: Do not assert on unrelated Strategy defaults.
   ```ts
   expect(config.targets[0].strategy.failureResolution).toMatchObject({
     agent: "resolver",
     maxAttemptsPerFailure: 2,
   });
   ```
2. pourkit/shared/config.test.ts / "defaults failureResolution maxAttemptsPerFailure"
   - Action: add test
   - Given: A Strategy includes `failureResolution` without `maxAttemptsPerFailure`.
   - When: `parseConfig(...)` runs.
   - Then: parsed Strategy has `maxAttemptsPerFailure: 3`.
   - Notes: Keep `failureLimits` absent in expected output unless schema materializes it.
   - Constraints: Do not require any Queue or Target changes.
   ```ts
   expect(config.targets[0].strategy.failureResolution.maxAttemptsPerFailure).toBe(3);
   ```
3. pourkit/shared/config.test.ts / "rejects conflictResolution with migration guidance"
   - Action: modify
   - Given: A Strategy contains `conflictResolution`.
   - When: `parseConfig(...)` runs.
   - Then: it throws a message telling users to use `targets[].strategy.failureResolution`.
   - Notes: Replace the old successful parse test for `conflictResolution`.
   - Constraints: The test must fail on current code.
   ```ts
   expect(() => parseConfig(rawConfig({ targets: [{ name: "test", strategy: { ...strategy(), conflictResolution: {} } }] }))).toThrow(
     "targets[0].strategy.conflictResolution has been removed; use targets[].strategy.failureResolution"
   );
   ```
4. pourkit/shared/config.ts / ReviewRefactorLoopStrategyInput
   - Action: modify
   - Given: TypeScript consumers reference Strategy input/output types.
   - When: config types compile.
   - Then: `failureResolution` is required and `conflictResolution` is absent.
   - Notes: Add `FailureResolutionConfigInput` and `FailureResolutionConfig` next to existing agent config types.
   - Constraints: Do not rename `StageAgentConfig`.
5. pourkit/shared/config.ts / ReviewRefactorLoopStrategySchema
   - Action: modify
   - Given: Config contains Strategy objects.
   - When: Zod parses the Strategy.
   - Then: `failureResolution` is required, `maxAttemptsPerFailure` defaults to `3`, and `failureLimits` values must be positive integers.
   - Notes: StageFailure key validation may use an enum or explicit key set from the first-slice taxonomy.
   - Constraints: Keep `.strict()` behavior for unknown Strategy keys.
6. pourkit/shared/config.ts / checkRemovedFields(...)
   - Action: modify
   - Given: A Strategy contains `conflictResolution`.
   - When: removed-field preflight runs.
   - Then: it throws the migration message before generic unknown-key formatting.
   - Notes: Check target strategy objects inside the target loop.
   - Constraints: Do not change existing top-level or target-level removed-field checks.
7. pourkit/shared/config.typecheck.ts / config type fixtures
   - Action: modify
   - Given: Type fixtures construct Strategies.
   - When: TypeScript checks the file.
   - Then: fixtures use `failureResolution`, not `conflictResolution`.
   - Notes: Keep one negative fixture for legacy `conflictResolution` only if the file already uses compile-error fixtures.
   - Constraints: Do not add runtime behavior to the typecheck file.
8. pourkit.config.example.ts / exported config object
   - Action: modify
   - Given: Users copy example config.
   - When: example config is parsed.
   - Then: it contains `strategy.failureResolution` with default-compatible fields.
   - Notes: Use existing example agent naming conventions.
   - Constraints: Do not add issue-specific policy examples beyond first-slice fields.

## Contracts / interfaces

```ts
export type StageFailureType =
  | "RebaseConflict"
  | "PublishedHistoryRisk"
  | "RecoveryArtifactInvalid"
  | "FailureResolutionAgentFailed";

export interface FailureResolutionConfigInput extends StageAgentConfig {
  maxAttemptsPerFailure?: number;
  failureLimits?: Partial<Record<StageFailureType, number>>;
}

export interface FailureResolutionConfig extends StageAgentConfig {
  maxAttemptsPerFailure: number;
  failureLimits?: Partial<Record<StageFailureType, number>>;
}
```

## Edge cases

- Missing `failureResolution` rejects because the field is required.
- `maxAttemptsPerFailure`, `failureLimits` zero, negative, or non-integer values reject.
- Legacy `conflictResolution` rejects with migration guidance, not unknown-key noise.

## Validation

- New behavior test: config parses required `failureResolution`, default budget, and `failureLimits`.
- Regression contract test: canonical review-refactor-loop Strategy still parses existing agent fields.
- Existing command that should still pass: repository config test command.
- Manual/example verification: inspect example config for `failureResolution`.

## Out of scope

- Do not wire Failure Resolution Agent execution in this issue.
- Do not add Stage Attempt runtime behavior in this issue.
- Do not migrate unrelated config fields.

## Priority

feature

## Acceptance criteria

- [ ] Config parsing requires `strategy.failureResolution` for every Strategy.
- [ ] Config parsing defaults `maxAttemptsPerFailure` to `3` and accepts positive integer `failureLimits`.
- [ ] Config parsing rejects `strategy.conflictResolution` with migration guidance to `strategy.failureResolution`.
- [ ] Existing Builder, Reviewer, Refactor, Verify, and Finalize config parsing still passes.

## Blocked by

None — can start immediately.

## Parent

Parent PRD: #74 (PRD-037: Base Refresh failure resolution control plane)

## Source of truth for behavior

Explicit new contract defined in PRD-037 implementation decisions. Existing config.ts types, Zod schemas, and migration-error patterns (checkRemovedFields, assertKnownKeys) serve as prior art for structure and style.

## What to build

Add a required `strategy.failureResolution` config field to the `ReviewRefactorLoopStrategy` config types, Zod schema, and parseConfig mapping. Reject `strategy.conflictResolution` with a migration message instructing users to use `strategy.failureResolution` instead. The new field includes `agent`, `model`, `promptTemplate`, `maxAttemptsPerFailure`, and optional `failureLimits` (per-failure-type attempt limits).

## Affected code paths

- pourkit/shared/config.ts
  - Module: Module-level types + schemas
  - Types: `FailureResolutionConfigInput`, `FailureResolutionConfig` (new)
  - Interfaces: Modify `ReviewRefactorLoopStrategyInput`, `ReviewRefactorLoopStrategy`
  - Functions: `parseConfig()` — add mapping for failureResolution, reject conflictResolution
  - Schemas: Add FailureResolutionConfigSchema to ReviewRefactorLoopStrategySchema
  - Test: assertKnownKeys strategy-level known keys list
- pourkit/shared/config.test.ts
  - Functions/Methods: Existing test helpers, new test cases
  - New: Yes/extend

## Current behavior

- `strategy.conflictResolution` is accepted as an optional config field with `agent`, `model`, `promptTemplate`, `maxAttempts`.
- No `strategy.failureResolution` field exists.
- No migration validation rejects `conflictResolution`.

## Desired behavior

- `strategy.failureResolution` is a required field with `agent`, `model`, `promptTemplate`, `maxAttemptsPerFailure`, and optional `failureLimits`.
- `strategy.conflictResolution` is rejected at config parse time with a clear migration message pointing to `failureResolution`.
- Existing config files using `conflictResolution` fail immediately with guidance to migrate.

## Contract decisions

- Decision: `strategy.failureResolution` is required, not optional. Source: PRD-037, DEC-0008.
- Decision: `conflictResolution` must be rejected at config parse time, not silently ignored. Source: PRD-037, DEC-0008.
- Decision: Migration message follows existing removed-field pattern: `"targets[N].strategy.conflictResolution has been removed; use targets[N].strategy.failureResolution"`. Source: config.ts checkRemovedFields pattern.
- Decision: `failureLimits` is optional map of string to number (failure type name to max attempts), validated as positive integers. Source: PRD-037, DEC-0009.
- Decision: `maxAttemptsPerFailure` is a required positive integer, default 1 (conservative first-slice default). Source: PRD-037 implementation decisions.

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: `parseConfig` accepts a canonical `ReviewRefactorLoopStrategy` and returns `PourkitConfig` with all fields mapped.
  - Why it is at risk: Adding required `failureResolution` means every test fixture must include it.
  - Test that protects it: "parses canonical review-refactor-loop strategy" test must add `failureResolution`. Existing "parses strategy with conflictResolution section" test updated to expect rejection.
  - Must not change: All existing valid config fields (implement.builder, review, verify, finalize) must still parse with added `failureResolution`.
- Existing behavior:
  - What currently works: `checkRemovedFields` rejects known-removed config keys with migration messages.
  - Why it is at risk: `conflictResolution` is nested inside `strategy`, not at target level.
  - Test that protects it: New test "rejects strategy.conflictResolution with migration message".
  - Must not change: Existing removed-field rejections (verificationCommands, implementor, etc.) must still fire.
- Existing behavior:
  - What currently works: Zod strict mode rejects unknown strategy-level keys.
  - Why it is at risk: `conflictResolution` must be caught by the rejection check before Zod, since Zod strict mode would also catch it but with a less clear message.
  - Test that protects it: "rejects strategy.conflictResolution with migration message" proves the migration-specific message, not a generic "not supported" error.
  - Must not change: Other known strategy keys (implement, review, verify, finalize) must still be accepted.

## Step-by-step implementation

1. pourkit/shared/config.ts / Add FailureResolution types
   - Action: add
   - Given: No failureResolution types exist.
   - When: Types are added.
   - Then: `FailureResolutionConfigInput` and `FailureResolutionConfig` interfaces exist with `agent`, `model`, `promptTemplate`, `maxAttemptsPerFailure`, and optional `failureLimits`.
   - Notes: Mirror `ConflictResolutionConfigInput`/`ConflictResolutionConfig` pattern but add `failureLimits` and use `maxAttemptsPerFailure` not `maxAttempts`.
   - Constraints: Do not remove existing ConflictResolution types yet.

2. pourkit/shared/config.ts / Add failureResolution to strategy interfaces
   - Action: modify
   - Given: `ReviewRefactorLoopStrategyInput` and `ReviewRefactorLoopStrategy` have optional `conflictResolution`.
   - When: The interfaces are modified.
   - Then: `failureResolution: FailureResolutionConfigInput` (required) on Input. `failureResolution: FailureResolutionConfig` (required) on Strategy.
   - Notes: Make failureResolution required. Keep conflictResolution in Input temporarily for rejection.
   - Constraints: Do not remove conflictResolution from Input yet — parseConfig rejects it before Zod runs.

3. pourkit/shared/config.ts / Add FailureResolution Zod schema
   - Action: modify
   - Given: `ReviewRefactorLoopStrategySchema` has optional `conflictResolution`.
   - When: FailureResolutionConfigSchema is added and referenced in ReviewRefactorLoopStrategySchema.
   - Then: Schema validates agent (non-empty string), model (non-empty string), promptTemplate (non-empty string), maxAttemptsPerFailure (positive integer), optional failureLimits (record of string → positive integer).
   - Notes: Use `.strict()`. conflictResolution stays optional in schema temporarily.
   ```ts
   const FailureResolutionConfigSchema = z.object({
     agent: NonEmptyString,
     model: NonEmptyString,
     promptTemplate: NonEmptyString,
     maxAttemptsPerFailure: z.number().int().positive(),
     failureLimits: z.record(z.string(), z.number().int().positive()).optional(),
   }).strict();
   ```

4. pourkit/shared/config.ts / Reject conflictResolution in parseConfig
   - Action: modify
   - Given: `parseConfig` processes strategy config.
   - When: Strategy has `conflictResolution` field.
   - Then: Throws `"targets[N].strategy.conflictResolution has been removed; use targets[N].strategy.failureResolution"`.
   - Notes: Add loop over raw targets checking strategy.conflictResolution before Zod validation.
   ```ts
   for (let i = 0; i < rawTargets.length; i++) {
     const t = rawTargets[i];
     const strategy = t?.strategy as Record<string, unknown> | undefined;
     if (strategy && typeof strategy === "object" && "conflictResolution" in strategy) {
       throw new Error(`targets[${i}].strategy.conflictResolution has been removed; use targets[${i}].strategy.failureResolution`);
     }
   }
   ```
   - Constraints: Must fire before Zod validation for clear message.

5. pourkit/shared/config.ts / Map failureResolution in parseConfig return
   - Action: modify
   - Given: `parseConfig` maps strategy fields to return object.
   - When: Building the strategy return.
   - Then: `failureResolution` is mapped from Zod-validated input. `conflictResolution` conditional spread is removed.
   - Notes: Required field so no conditional.
   ```ts
   failureResolution: {
     agent: t.strategy.failureResolution.agent,
     model: t.strategy.failureResolution.model,
     promptTemplate: t.strategy.failureResolution.promptTemplate,
     maxAttemptsPerFailure: t.strategy.failureResolution.maxAttemptsPerFailure,
     failureLimits: t.strategy.failureResolution.failureLimits,
   },
   ```
   - Constraints: Must not include `conflictResolution` in the output strategy.

6. pourkit/shared/config.test.ts / Update strategy() test helper
   - Action: modify
   - Given: `strategy()` helper creates test configs without `failureResolution`.
   - When: Helper is called.
   - Then: Includes default `failureResolution` so existing tests pass.
   - Notes: Add minimal valid default.
   ```ts
   function strategy(overrides: Partial<ReviewRefactorLoopStrategy> = {}): ReviewRefactorLoopStrategy {
     return {
       type: "review-refactor-loop",
       implement: { builder },
       failureResolution: {
         agent: "resolve-agent",
         model: "resolve-model",
         promptTemplate: "failure-resolution.prompt.md",
         maxAttemptsPerFailure: 1,
       },
       review: { ... },
       verify: { ... },
       finalize: { ... },
       ...overrides,
     };
   }
   ```
   - Constraints: Default must be valid (positive integer, non-empty strings).

7. pourkit/shared/config.test.ts / Add valid failureResolution test
   - Action: add test
   - Given: Valid config with failureResolution.
   - When: parseConfig runs.
   - Then: Returns PourkitConfig with failureResolution mapped correctly.
   ```ts
   it("parses strategy with required failureResolution config", () => {
     // Test valid parse with failureLimits override
   });
   ```
   - Constraints: Must verify all fields including optional failureLimits.

8. pourkit/shared/config.test.ts / Add conflictResolution rejection test
   - Action: add test
   - Given: Config with strategy.conflictResolution.
   - When: parseConfig runs.
   - Then: Throws migration message.
   ```ts
   it("rejects strategy.conflictResolution with migration message", () => {
     expect(() => parseConfig(...)).toThrow(
       /conflictResolution has been removed.*failureResolution/
     );
   });
   ```
   - Constraints: The test must fail without the change.

9. pourkit/shared/config.test.ts / Add validation edge case tests
   - Action: add test
   - Given: Configs with invalid failureResolution (missing, zero, negative).
   - When: parseConfig runs.
   - Then: Appropriate validation errors.
   - Notes: Test missing maxAttemptsPerFailure, zero value, zero failureLimits value.
   ```ts
   it("rejects failureResolution with missing maxAttemptsPerFailure", () => { ... });
   it("rejects failureResolution with zero maxAttemptsPerFailure", () => { ... });
   it("rejects failureResolution with non-positive failureLimits value", () => { ... });
   ```
   - Constraints: Error messages must be specific.

## Contracts / interfaces

```ts
export interface FailureResolutionConfigInput {
  agent: string;
  model: string;
  promptTemplate: string;
  maxAttemptsPerFailure: number;
  failureLimits?: Record<string, number>;
}

export interface FailureResolutionConfig {
  agent: string;
  model: string;
  promptTemplate: string;
  maxAttemptsPerFailure: number;
  failureLimits?: Record<string, number>;
}
```

## Edge cases

- Missing `failureResolution` entirely: fails with clear validation error.
- `failureLimits` entries with zero or negative values: rejected.
- `conflictResolution` still present alongside valid `failureResolution`: rejected with migration message (must be removed, not overridden).

## Validation

- New behavior test: valid failureResolution config parses correctly.
- Regression contract test: conflictResolution rejected with migration message.
- Regression contract test: Existing parseConfig tests pass with updated fixtures.
- Validation test: missing/zero/invalid values rejected.

## Out of scope

- None — scope is self-contained.

## Priority

feature

## Acceptance criteria

- [ ] `parseConfig` accepts valid `strategy.failureResolution` and maps all fields.
- [ ] `parseConfig` rejects `strategy.conflictResolution` with migration message.
- [ ] All existing parseConfig tests pass after fixture update.
- [ ] `failureResolution` is required — configs without it fail.
- [ ] `failureLimits` accepts valid entries, rejects zero/negative.
- [ ] `maxAttemptsPerFailure` is required, positive integer.

## Blocked by

- None — can start immediately.

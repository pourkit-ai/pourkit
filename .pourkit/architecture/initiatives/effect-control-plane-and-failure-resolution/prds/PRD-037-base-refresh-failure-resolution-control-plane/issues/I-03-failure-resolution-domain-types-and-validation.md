## Parent

Parent PRD: #74 (PRD-037: Base Refresh failure resolution control plane)

## Source of truth for behavior

Explicit new contract defined in PRD-037 implementation decisions, DEC-0013, DEC-0015, DEC-0016, DEC-0028. RecoveryArtifact format from DEC-0011, DEC-0026, DEC-0027. Effect error-management patterns from `@effect-ts` skill references.

## What to build

Create a domain module under `pourkit/failure-resolution/` containing: StageFailure typed error taxonomy (RebaseConflict, PublishedHistoryRisk, RecoveryArtifactInvalid, FailureResolutionAgentFailed), RecoveryDecision enum (RETRY_STAGE, HANDOFF_TO_HUMAN, FAIL_RUN with RESUME_FROM_STAGE and MARK_STAGE_COMPLETE parsed but rejected for this slice), FailureResolutionPacket type (structured context sent to FR agent), and RecoveryArtifact types with markdown JSON block parsing and validation. This is pure TypeScript (no Effect dependency) — type definitions and standalone validators.

## Affected code paths

- pourkit/failure-resolution/types.ts (new)
  - Types: `StageFailure`, `StageFailureTag`, `RecoveryDecision`, `FailureResolutionPacket`, `RecoveryArtifact`, `RecoveryArtifactJson`
  - Functions: `parseRecoveryArtifact()`, `validateRecoveryDecision()`, `isSupportedRecoveryDecision()`
  - New: Yes
- pourkit/failure-resolution/types.test.ts (new)
  - New: Yes

## Current behavior

- No StageFailure taxonomy exists. Base Refresh failures are plain `BaseRefreshResult` discriminated union with string status.
- No RecoveryDecision type exists. Conflict resolution uses `resolved`/`ambiguous`/`failed`/`exhausted` status strings.
- No FailureResolutionPacket exists.
- No RecoveryArtifact parsing exists (separate ConflictResolutionArtifact parser exists).
- Conflict Resolution Agent artifact uses a `## Status`/`## Summary`/`## Files` markdown format with XML-like markers.

## Desired behavior

- `StageFailure` is a discriminated union of Effect `Data.TaggedError` types for first-slice failure types.
- `RecoveryDecision` is a string enum with `RETRY_STAGE`, `HANDOFF_TO_HUMAN`, `FAIL_RUN` as supported. `RESUME_FROM_STAGE` and `MARK_STAGE_COMPLETE` are valid enum values but `isSupportedRecoveryDecision()` returns `false` for them in this slice.
- `FailureResolutionPacket` is a plain interface containing failure type, stage name, attempt number, Worktree path, branch/base context, conflicted paths (when present), failure summary, policy limits, allowed decisions, and artifact target path.
- `RecoveryArtifact` is parsed from a markdown file containing a JSON code block. The JSON block includes: `recoveryDecision`, `summary`, `changedFiles`, `verificationSummary`, `verificationCommands`, `notes`. Validation ensures required fields present, decision is allowed, and changed files list is valid.
- Artifact path convention: `.pourkit/.tmp/failure-resolution/attempt-{n}.md`

## Contract decisions

- Decision: `StageFailure` uses `Data.TaggedError` from Effect for discriminated error types, but the module does not depend on Effect — types are plain and reusable with or without Effect. Source: DEC-0002 mixed codebase.
- Decision: First-slice StageFailure types: `RebaseConflict`, `PublishedHistoryRisk`, `RecoveryArtifactInvalid`, `FailureResolutionAgentFailed`. Source: PRD-037 Implementation Decisions.
- Decision: `PublishedHistoryRisk` routes directly to `HANDOFF_TO_HUMAN` — no AI recovery. Source: DEC-0015, User Story 3.
- Decision: `RecoveryDecision` values: `RETRY_STAGE`, `HANDOFF_TO_HUMAN`, `FAIL_RUN` are executable. `RESUME_FROM_STAGE` and `MARK_STAGE_COMPLETE` are valid enum values but rejected as unsupported for Base Refresh. Source: DEC-0013, PRD-037 Implementation Decisions.
- Decision: `FailureResolutionPacket` path: `.pourkit/.tmp/failure-resolution/attempt-{n}.md` for artifact output. Source: DEC-0011.
- Decision: RecoveryArtifact JSON block is parsed from a markdown fenced code block with language `json`. Source: DEC-0011.
- Decision: Required RecoveryArtifact JSON fields: `recoveryDecision`, `summary`, `changedFiles`. Source: PRD-037 Implementation Decisions.
- Decision: `FailureResolutionAgentFailed` is a StageFailure when the agent itself fails (timeout, malformed artifact, execution error). Source: DEC-0028.

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: `pourkit/conflicts/conflict-resolution-artifact.ts` parses Conflict Resolution Agent artifacts with `## Status`/`## Summary`/`## Files` sections and XML markers.
  - Why it is at risk: New RecoveryArtifact parsing follows a different format (markdown with JSON block). The old parser must remain untouched.
  - Test that protects it: Existing `parseConflictResolutionArtifact` tests must still pass unchanged.
  - Must not change: `conflict-resolution-artifact.ts` module, `ConflictResolutionArtifactProtocolError`.
- Existing behavior:
  - What currently works: `BaseRefreshResult` type in `pourkit/commands/base-refresh.ts` has string status variants.
  - Why it is at risk: New StageFailure types may tempt the builder to delete or replace `BaseRefreshResult`.
  - Test that protects it: `base-refresh.ts` unit tests (or at minimum, type-level verification that `BaseRefreshResult` still exists).
  - Must not change: `BaseRefreshResult` type and its `refreshStaleIssueBranch` function signature.
- Existing behavior:
  - What currently works: `pourkit/commands/conflict-resolution.ts` exports `ConflictResolutionRunResult`, `ConflictResolutionLoopResult` types.
  - Why it is at risk: New RecoveryDecision and FailureResolution types should not replace the existing conflict-resolution types yet.
  - Test that protects it: Import from `conflict-resolution.ts` should still resolve existing types.
  - Must not change: `conflict-resolution.ts` module exports.

## Step-by-step implementation

1. pourkit/failure-resolution/types.ts / Define StageFailure types
   - Action: add
   - Given: No StageFailure types exist.
   - When: Types are added.
   - Then: `StageFailureTag` union type `"RebaseConflict" | "PublishedHistoryRisk" | "RecoveryArtifactInvalid" | "FailureResolutionAgentFailed"`. `RebaseConflict extends Data.TaggedError("RebaseConflict")` with `conflictedPaths: string[]` and `message: string`. `PublishedHistoryRisk extends Data.TaggedError("PublishedHistoryRisk")` with `prNumber: number` and `prState: string`. `RecoveryArtifactInvalid extends Data.TaggedError("RecoveryArtifactInvalid")` with `reason: string`. `FailureResolutionAgentFailed extends Data.TaggedError("FailureResolutionAgentFailed")` with `reason: string`.
   - Notes: These are plain classes extending `Data.TaggedError` but also usable as plain types outside Effect. Do not import from `effect` in this module yet.
   - Constraints: Must not depend on Effect runtime — just the `Data.TaggedError` pattern.

   ```ts
   export type StageFailureTag = "RebaseConflict" | "PublishedHistoryRisk" | "RecoveryArtifactInvalid" | "FailureResolutionAgentFailed";

   export class RebaseConflict extends Data.TaggedError("RebaseConflict")<{
     readonly conflictedPaths: string[];
     readonly message: string;
   }> {}

   export class PublishedHistoryRisk extends Data.TaggedError("PublishedHistoryRisk")<{
     readonly prNumber: number;
     readonly prState: "OPEN" | "CLOSED" | "MERGED";
   }> {}

   export class RecoveryArtifactInvalid extends Data.TaggedError("RecoveryArtifactInvalid")<{
     readonly reason: string;
   }> {}

   export class FailureResolutionAgentFailed extends Data.TaggedError("FailureResolutionAgentFailed")<{
     readonly reason: string;
   }> {}

   export type StageFailure = RebaseConflict | PublishedHistoryRisk | RecoveryArtifactInvalid | FailureResolutionAgentFailed;
   ```

2. pourkit/failure-resolution/types.ts / Define RecoveryDecision
   - Action: add
   - Given: No RecoveryDecision type exists.
   - When: Type is added.
   - Then: `RecoveryDecision` is a `string` type with `"RETRY_STAGE" | "RESUME_FROM_STAGE" | "MARK_STAGE_COMPLETE" | "HANDOFF_TO_HUMAN" | "FAIL_RUN"`. Helper `isSupportedRecoveryDecision(d: string): d is RecoveryDecision` returns `true` only for `RETRY_STAGE`, `HANDOFF_TO_HUMAN`, `FAIL_RUN`.
   - Notes: `RESUME_FROM_STAGE` and `MARK_STAGE_COMPLETE` are parseable but flagged as unsupported for this slice.
   - Constraints: String union for flexibility — not a numeric enum.

   ```ts
   export type RecoveryDecision = "RETRY_STAGE" | "RESUME_FROM_STAGE" | "MARK_STAGE_COMPLETE" | "HANDOFF_TO_HUMAN" | "FAIL_RUN";

   const SUPPORTED_DECISIONS: ReadonlySet<string> = new Set(["RETRY_STAGE", "HANDOFF_TO_HUMAN", "FAIL_RUN"]);

   export function isSupportedRecoveryDecision(decision: string): decision is RecoveryDecision {
     return SUPPORTED_DECISIONS.has(decision);
   }
   ```

3. pourkit/failure-resolution/types.ts / Define FailureResolutionPacket
   - Action: add
   - Given: No packet type exists.
   - When: Type is added.
   - Then: `FailureResolutionPacket` interface with `failureType: StageFailureTag`, `stageName: string`, `attemptNumber: number`, `worktreePath: string`, `branchName: string`, `baseBranch: string`, `conflictedPaths?: string[]`, `failureSummary: string`, `maxAttempts: number`, `allowedDecisions: RecoveryDecision[]`, `artifactTarget: string`.
   - Notes: Plain interface — no methods. The packet is constructed by the host and passed as context to the FR agent.
   - Constraints: All fields are readonly.

   ```ts
   export interface FailureResolutionPacket {
     readonly failureType: StageFailureTag;
     readonly stageName: string;
     readonly attemptNumber: number;
     readonly worktreePath: string;
     readonly branchName: string;
     readonly baseBranch: string;
     readonly conflictedPaths?: string[];
     readonly failureSummary: string;
     readonly maxAttempts: number;
     readonly allowedDecisions: readonly RecoveryDecision[];
     readonly artifactTarget: string;
   }
   ```

4. pourkit/failure-resolution/types.ts / Define RecoveryArtifact types and parser
   - Action: add
   - Given: No RecoveryArtifact types exist.
   - When: Types and parseRecoveryArtifact function are added.
   - Then: `RecoveryArtifactJson` interface for the JSON block with `recoveryDecision: string`, `summary: string`, `changedFiles: string[]`, `verificationSummary?: string`, `verificationCommands?: string[]`, `notes?: string`. `RecoveryArtifact` type with `raw: string`, `json: RecoveryArtifactJson`. `parseRecoveryArtifact(markdown: string)` returns `RecoveryArtifact` or throws `RecoveryArtifactInvalid`.
   - Notes: Parse markdown for a fenced JSON code block (```json ... ```). Validate required fields, array shapes.
   - Constraints: Must throw `RecoveryArtifactInvalid` (from StageFailure types) on parse failure.

   ```ts
   export interface RecoveryArtifactJson {
     readonly recoveryDecision: string;
     readonly summary: string;
     readonly changedFiles: readonly string[];
     readonly verificationSummary?: string;
     readonly verificationCommands?: readonly string[];
     readonly notes?: string;
   }

   export interface RecoveryArtifact {
     readonly raw: string;
     readonly json: RecoveryArtifactJson;
     readonly path: string;
   }
   ```

5. pourkit/failure-resolution/types.ts / Implement parseRecoveryArtifact
   - Action: add
   - Given: Markdown text containing a ```json ... ``` block.
   - When: `parseRecoveryArtifact(markdown, artifactPath)` is called.
   - Then: Extracts JSON block, parses it, validates required fields, returns `RecoveryArtifact`. If no JSON block found, JSON parse fails, or required fields missing, throws `RecoveryArtifactInvalid` with descriptive reason.
   - Notes: Use regex to extract fenced JSON block. Validate `recoveryDecision` is non-empty string, `summary` is non-empty string, `changedFiles` is array of strings.
   - Constraints: Must not use Effect — pure TypeScript. Must not import from `fs` — caller reads the file.

   ```ts
   const JSON_BLOCK_RE = /```json\n([\s\S]*?)```/;

   export function parseRecoveryArtifact(markdown: string, artifactPath: string): RecoveryArtifact {
     const match = JSON_BLOCK_RE.exec(markdown);
     if (!match) {
       throw new RecoveryArtifactInvalid({ reason: `No JSON code block found in artifact at ${artifactPath}` });
     }
     let parsed: unknown;
     try {
       parsed = JSON.parse(match[1]);
     } catch {
       throw new RecoveryArtifactInvalid({ reason: `Malformed JSON in artifact at ${artifactPath}` });
     }
     const json = parsed as Record<string, unknown>;
     if (typeof json.recoveryDecision !== "string" || json.recoveryDecision === "") {
       throw new RecoveryArtifactInvalid({ reason: `Missing or empty recoveryDecision in artifact at ${artifactPath}` });
     }
     if (typeof json.summary !== "string" || json.summary === "") {
       throw new RecoveryArtifactInvalid({ reason: `Missing or empty summary in artifact at ${artifactPath}` });
     }
     if (!Array.isArray(json.changedFiles) || !json.changedFiles.every((f: unknown) => typeof f === "string")) {
       throw new RecoveryArtifactInvalid({ reason: `changedFiles must be an array of strings in artifact at ${artifactPath}` });
     }
     return {
       raw: markdown,
       json: json as RecoveryArtifactJson,
       path: artifactPath,
     };
   }
   ```
   - Constraints: Must throw `RecoveryArtifactInvalid` for all failure cases.

6. pourkit/failure-resolution/types.ts / Implement validateRecoveryDecision
   - Action: add
   - Given: A RecoveryArtifact and allowed decisions list.
   - When: `validateRecoveryDecision(artifact, allowedDecisions)` is called.
   - Then: Returns `{ valid: true, decision: RecoveryDecision }` or `{ valid: false, reason: string }`. Validates decision is in allowed list and is supported.
   - Notes: reuses `isSupportedRecoveryDecision`.
   - Constraints: Must not throw — returns result object.

   ```ts
   export interface DecisionValidation {
     readonly valid: boolean;
     readonly decision?: RecoveryDecision;
     readonly reason?: string;
   }

   export function validateRecoveryDecision(
     artifact: RecoveryArtifact,
     allowedDecisions: readonly RecoveryDecision[]
   ): DecisionValidation {
     const decision = artifact.json.recoveryDecision;
     if (!allowedDecisions.includes(decision as RecoveryDecision)) {
       return { valid: false, reason: `Decision "${decision}" is not in allowed list: ${allowedDecisions.join(", ")}` };
     }
     if (!isSupportedRecoveryDecision(decision)) {
       return { valid: false, reason: `Decision "${decision}" is not supported in this slice` };
     }
     return { valid: true, decision: decision as RecoveryDecision };
   }
   ```
   - Constraints: Must handle arbitrary string input gracefully.

7. pourkit/failure-resolution/types.test.ts / Add type definition tests
   - Action: add test
   - Given: Valid StageFailure instances.
   - When: Instances are created.
   - Then: They have correct `_tag` discriminants and fields.
   - Notes: Use `instanceof` checks where applicable.

   ```ts
   it("creates RebaseConflict with correct tag and fields", () => {
     const err = new RebaseConflict({ conflictedPaths: ["file.ts"], message: "Conflict in file.ts" });
     expect(err._tag).toBe("RebaseConflict");
     expect(err.conflictedPaths).toEqual(["file.ts"]);
   });
   ```

8. pourkit/failure-resolution/types.test.ts / Add RecoveryArtifact parsing tests
   - Action: add test
   - Given: Markdown text with valid JSON block.
   - When: `parseRecoveryArtifact` is called.
   - Then: Returns parsed RecoveryArtifact.
   - Notes: Test valid case, missing JSON block, malformed JSON, missing required fields.

   ```ts
   it("parses valid RecoveryArtifact JSON block", () => {
     const md = [
       "# Recovery Report",
       "",
       "```json",
       JSON.stringify({ recoveryDecision: "RETRY_STAGE", summary: "Fixed conflicts", changedFiles: ["file.ts"] }),
       "```",
     ].join("\n");
     const result = parseRecoveryArtifact(md, "attempt-1.md");
     expect(result.json.recoveryDecision).toBe("RETRY_STAGE");
     expect(result.json.changedFiles).toEqual(["file.ts"]);
   });

   it("throws RecoveryArtifactInvalid for missing JSON block", () => {
     const md = "# Just a summary";
     expect(() => parseRecoveryArtifact(md, "bad.md")).toThrow(RecoveryArtifactInvalid);
   });

   it("throws RecoveryArtifactInvalid for malformed JSON", () => {
     const md = "```json\n{ invalid }\n```";
     expect(() => parseRecoveryArtifact(md, "bad.md")).toThrow(RecoveryArtifactInvalid);
   });

   it("throws RecoveryArtifactInvalid for missing required fields", () => {
     const md = "```json\n" + JSON.stringify({ recoveryDecision: "RETRY_STAGE" }) + "\n```";
     expect(() => parseRecoveryArtifact(md, "bad.md")).toThrow(RecoveryArtifactInvalid);
   });
   ```

9. pourkit/failure-resolution/types.test.ts / Add RecoveryDecision validation tests
   - Action: add test
   - Given: Various decision strings.
   - When: `isSupportedRecoveryDecision` and `validateRecoveryDecision` are called.
   - Then: Correct support/validation results.
   - Notes: Test supported, unsupported-but-valid (RESUME_FROM_STAGE), and unknown strings.

   ```ts
   it("supports RETRY_STAGE, HANDOFF_TO_HUMAN, FAIL_RUN", () => {
     expect(isSupportedRecoveryDecision("RETRY_STAGE")).toBe(true);
     expect(isSupportedRecoveryDecision("HANDOFF_TO_HUMAN")).toBe(true);
     expect(isSupportedRecoveryDecision("FAIL_RUN")).toBe(true);
   });

   it("rejects RESUME_FROM_STAGE and MARK_STAGE_COMPLETE as unsupported", () => {
     expect(isSupportedRecoveryDecision("RESUME_FROM_STAGE")).toBe(false);
     expect(isSupportedRecoveryDecision("MARK_STAGE_COMPLETE")).toBe(false);
   });

   it("validates allowed decisions against packet", () => {
     const artifact = { raw: "", json: { recoveryDecision: "RETRY_STAGE", summary: "ok", changedFiles: [] }, path: "test.md" };
     const result = validateRecoveryDecision(artifact, ["RETRY_STAGE", "HANDOFF_TO_HUMAN"]);
     expect(result.valid).toBe(true);
     expect(result.decision).toBe("RETRY_STAGE");
   });
   ```

10. pourkit/failure-resolution/types.test.ts / Add FailureResolutionPacket test
    - Action: add test
    - Given: FailureResolutionPacket fields.
    - When: A packet is constructed.
    - Then: All fields are accessible.
    - Notes: Type-level test ensuring the interface is usable.

    ```ts
    it("constructs a valid FailureResolutionPacket", () => {
      const packet: FailureResolutionPacket = {
        failureType: "RebaseConflict",
        stageName: "baseRefresh",
        attemptNumber: 1,
        worktreePath: "/tmp/worktree",
        branchName: "pourkit/42/test",
        baseBranch: "main",
        conflictedPaths: ["file.ts"],
        failureSummary: "Conflict in file.ts",
        maxAttempts: 3,
        allowedDecisions: ["RETRY_STAGE", "HANDOFF_TO_HUMAN"],
        artifactTarget: ".pourkit/.tmp/failure-resolution/attempt-1.md",
      };
      expect(packet.failureType).toBe("RebaseConflict");
      expect(packet.artifactTarget).toContain("attempt-1.md");
    });
    ```

## Contracts / interfaces

```ts
// StageFailure taxonomy
export type StageFailureTag = "RebaseConflict" | "PublishedHistoryRisk" | "RecoveryArtifactInvalid" | "FailureResolutionAgentFailed";

export class RebaseConflict extends Data.TaggedError("RebaseConflict")<{
  readonly conflictedPaths: string[];
  readonly message: string;
}> {}

export class PublishedHistoryRisk extends Data.TaggedError("PublishedHistoryRisk")<{
  readonly prNumber: number;
  readonly prState: "OPEN" | "CLOSED" | "MERGED";
}> {}

export class RecoveryArtifactInvalid extends Data.TaggedError("RecoveryArtifactInvalid")<{
  readonly reason: string;
}> {}

export class FailureResolutionAgentFailed extends Data.TaggedError("FailureResolutionAgentFailed")<{
  readonly reason: string;
}> {}

export type StageFailure = RebaseConflict | PublishedHistoryRisk | RecoveryArtifactInvalid | FailureResolutionAgentFailed;

// RecoveryDecision
export type RecoveryDecision = "RETRY_STAGE" | "RESUME_FROM_STAGE" | "MARK_STAGE_COMPLETE" | "HANDOFF_TO_HUMAN" | "FAIL_RUN";
export function isSupportedRecoveryDecision(decision: string): decision is RecoveryDecision;

// FailureResolutionPacket
export interface FailureResolutionPacket {
  readonly failureType: StageFailureTag;
  readonly stageName: string;
  readonly attemptNumber: number;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly conflictedPaths?: string[];
  readonly failureSummary: string;
  readonly maxAttempts: number;
  readonly allowedDecisions: readonly RecoveryDecision[];
  readonly artifactTarget: string;
}

// RecoveryArtifact
export interface RecoveryArtifactJson {
  readonly recoveryDecision: string;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly verificationSummary?: string;
  readonly verificationCommands?: readonly string[];
  readonly notes?: string;
}

export interface RecoveryArtifact {
  readonly raw: string;
  readonly json: RecoveryArtifactJson;
  readonly path: string;
}

// Parsing and validation
export function parseRecoveryArtifact(markdown: string, artifactPath: string): RecoveryArtifact;
export interface DecisionValidation { readonly valid: boolean; readonly decision?: RecoveryDecision; readonly reason?: string; }
export function validateRecoveryDecision(artifact: RecoveryArtifact, allowedDecisions: readonly RecoveryDecision[]): DecisionValidation;
```

## Edge cases

- Artifact markdown with multiple JSON blocks: only the first ```json block is used.
- Artifact with JSON block but wrong language tag (e.g. ```typescript): not matched — treated as missing JSON block.
- Empty changedFiles array: valid (no files changed).
- Unrecognized decision string: caught by `isSupportedRecoveryDecision` returning false.

## Validation

- New behavior test: valid RecoveryArtifact parses correctly.
- Regression contract test: existing `parseConflictResolutionArtifact` tests still pass.
- Validation edge case: missing/malformed JSON, missing fields, unsupported decisions all produce `RecoveryArtifactInvalid`.
- RecoveryDecision tests: supported/unsupported decisions correctly identified.

## Out of scope

- None — scope is self-contained.

## Priority

infra

## Acceptance criteria

- [ ] `RebaseConflict`, `PublishedHistoryRisk`, `RecoveryArtifactInvalid`, `FailureResolutionAgentFailed` are defined as `Data.TaggedError` classes with correct tags.
- [ ] `RecoveryDecision` type includes all 5 enum values; `isSupportedRecoveryDecision` returns true only for `RETRY_STAGE`, `HANDOFF_TO_HUMAN`, `FAIL_RUN`.
- [ ] `FailureResolutionPacket` interface contains all required fields.
- [ ] `parseRecoveryArtifact` extracts and validates JSON block from markdown, throws `RecoveryArtifactInvalid` on failure.
- [ ] `validateRecoveryDecision` checks allowed and supported decisions.
- [ ] Existing `conflict-resolution-artifact.ts` tests still pass unchanged.

## Blocked by

- None — can start immediately.

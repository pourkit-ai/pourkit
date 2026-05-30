## Parent

Parent PRD: #74 (PRD-037: Base Refresh failure resolution control plane)

## Source of truth for behavior

Explicit new contract defined in PRD-037 implementation decisions, DEC-0007, DEC-0010, DEC-0011, DEC-0012, DEC-0014, DEC-0015, DEC-0023, DEC-0025, DEC-0026, DEC-0027, DEC-0028. Prior art: existing `runConflictResolutionLoop` in `pourkit/commands/conflict-resolution.ts` and the conflict resolution wiring in `issue-run.ts`.

## What to build

Replace the conflict-resolution loop (`runConflictResolutionLoop`) in `startIssueRun` with Failure Resolution Agent invocation. When Base Refresh produces a RebaseConflict (via Effect stage attempt from I-04), the host constructs a `FailureResolutionPacket`, invokes the Failure Resolution Agent via `strategy.failureResolution`, parses and validates the `RecoveryArtifact`, evaluates the `RecoveryDecision` against policy, handles invalid/unsupported decisions, and records recovery attempts in the Attempt Log. After successful recovery, `invalidateAfterBaseRefresh` preserves Builder but clears downstream stages. PublishedHistoryRisk and security-sensitive failures go straight to Human Handoff. The host owns all Git state transitions (git add, git rebase --continue). Defects bypass the FR agent entirely.

## Affected code paths

- pourkit/failure-resolution/failure-resolution-agent.ts (new)
  - Module: New module
  - Types: `FailureResolutionAgentResult`, `RecoveryAttemptRecord`
  - Functions: `runFailureResolutionAgent()`, `constructFailureResolutionPacket()`
  - New: Yes
- pourkit/failure-resolution/recovery-policy.ts (new)
  - Module: New module
  - Functions: `evaluateRecoveryPolicy()`, `isSecuritySensitiveFailure()`
  - New: Yes
- pourkit/commands/issue-run.ts
  - Functions: `startIssueRun()` — replace conflict-resolution block with FR agent flow
  - New: No (modify)
- pourkit/failure-resolution/failure-resolution-agent.test.ts (new)
  - New: Yes
- pourkit/failure-resolution/recovery-policy.test.ts (new)
  - New: Yes
- pourkit/commands/issue.test.ts
  - Functions/Methods: Add regression test for FR agent integration
  - New: modify/extend

## Current behavior

- When Base Refresh has conflicts, `runConflictResolutionLoop` is invoked via `strategy.conflictResolution` config.
- Conflict Resolution Agent runs, edits files, produces artifact with `resolved`/`ambiguous` status.
- Runner runs `git add`, `git rebase --continue`, and host-run verification.
- No Failure Resolution Packet is constructed.
- No Recovery Artifact parsing exists.
- No attempt recording for recovery attempts.
- Human Handoff for unsafe failures is not structured through policy.

## Desired behavior

- After Base Refresh failure with RebaseConflict and `strategy.failureResolution` config present, the host constructs a `FailureResolutionPacket` from the failure context.
- The host invokes the Failure Resolution Agent (from `strategy.failureResolution`) with the packet as context.
- Agent produces a RecoveryArtifact (markdown with JSON block) at `.pourkit/.tmp/failure-resolution/attempt-{n}.md`.
- Host parses and validates the RecoveryArtifact.
- Host evaluates the agent's recommended RecoveryDecision against policy (allowed decisions, budget).
- Host makes final decision: `RETRY_STAGE` → re-runs Base Refresh; `HANDOFF_TO_HUMAN` → human handoff; `FAIL_RUN` → fail the run.
- Recovery attempt is recorded in Attempt Log with reference to the original failure fingerprint.
- After successful recovery (RETRY_STAGE succeeds), `invalidateAfterBaseRefresh` is called.
- PublishedHistoryRisk goes straight to HUMAN_HANDOFF without agent invocation.
- Security-sensitive failures (classified by failure type) go straight to HUMAN_HANDOFF.
- Agent execution failure produces `FailureResolutionAgentFailed` which goes through policy (typically HANDOFF_TO_HUMAN after budget check).
- Host owns all Git state transitions.

## Contract decisions

- Decision: After RebaseConflict, the host constructs FailureResolutionPacket from the StageFailure context (conflicted paths, message, etc.). Source: DEC-0010.
- Decision: The FR agent is invoked via `executionProvider.execute` similar to `runConflictResolutionOnce`. Source: DEC-0023, DEC-0007.
- Decision: Artifact path: `.pourkit/.tmp/failure-resolution/attempt-{n}.md`. Source: DEC-0011.
- Decision: Host parses and validates RecoveryArtifact JSON block. Invalid artifacts → `RecoveryArtifactInvalid` → recovery attempt failure → policy evaluation. Source: DEC-0011, DEC-0028.
- Decision: Host evaluates agent's recommended decision against allowed decisions and recovery budget. Source: DEC-0012.
- Decision: RETRY_STAGE re-runs Base Refresh (calls `runBaseRefreshAttempt` again). Budget is consumed. Source: DEC-0013, PRD-037.
- Decision: After successful RETRY_STAGE (Base Refresh succeeds), `invalidateAfterBaseRefresh` is called and downstream stages are rerun. Source: DEC-0025.
- Decision: PublishedHistoryRisk → HANDOFF_TO_HUMAN always (no AI recovery). Source: DEC-0015, User Story 3.
- Decision: Defects (unexpected exceptions) bypass FR agent. Captured via Effect defect handling. Source: DEC-0016.
- Decision: Host owns `git add` and `git rebase --continue` after agent edits files. Source: DEC-0023.
- Decision: Recovery attempt failures count against the original failure fingerprint's budget. Source: DEC-0028, DEC-0019.

## Regression contract (CRITICAL)

- Existing behavior:
  - What currently works: `runConflictResolutionLoop` is invoked when `strategy.conflictResolution` is configured; the loop runs agent iterations, git add, git rebase --continue.
  - Why it is at risk: The entire conflict-resolution code path is being replaced with FR agent flow. The old code path must be removed (migrated).
  - Test that protects it: New FR agent integration tests must cover all FR agent outcomes. Existing `runConflictResolutionLoop` tests in conflict-resolution.test.ts should continue to pass (the module still exists for reference until fully removed).
  - Must not change: The module `pourkit/commands/conflict-resolution.ts` and its tests should remain (they're not deleted in this slice, just unused).
- Existing behavior:
  - What currently works: `startIssueRun` handles the `refreshResult.status === "conflicted"` path by checking `strategy.conflictResolution`.
  - Why it is at risk: The condition must now check `strategy.failureResolution` instead.
  - Test that protects it: Existing issue.test.ts tests that exercise the conflict path (when conflictResolution is configured) must be updated to use failureResolution config and expect FR agent behavior.
  - Must not change: The non-conflict paths (refreshed, skipped-current, refused-published-history).
- Existing behavior:
  - What currently works: `invalidateAfterBaseRefresh` preserves builder completion but clears downstream stages.
  - Why it is at risk: After FR agent recovery, the same invalidation must occur.
  - Test that protects it: "clears downstream state after stale base refresh" test in issue.test.ts must still pass.
  - Must not change: `invalidateAfterBaseRefresh` function behavior.
- Existing behavior:
  - What currently works: Agent execution (`executionProvider.execute`) works for conflictResolution, builder, reviewer, refactor, finalizer stages.
  - Why it is at risk: The FR agent introduces a new stage value.
  - Test that protects it: The FR agent execution test must verify the stage name and that the execution provider receives correct options.
  - Must not change: Existing execution provider behavior for other stages.

## Step-by-step implementation

1. pourkit/failure-resolution/recovery-policy.ts / Implement isSecuritySensitiveFailure
   - Action: add
   - Given: A StageFailure instance.
   - When: `isSecuritySensitiveFailure(failure)` is called.
   - Then: Returns `true` if the failure is a security-sensitive type. For this slice, `PublishedHistoryRisk` returns `true`. Other StageFailure types return `false`.
   - Notes: Security-sensitive classification is explicit by failure type in this slice. Broader pattern detection deferred.
   - Constraints: Must not depend on Effect.

   ```ts
   import { type StageFailure, PublishedHistoryRisk } from "./types";

   export function isSecuritySensitiveFailure(failure: StageFailure): boolean {
     return failure instanceof PublishedHistoryRisk;
   }
   ```

2. pourkit/failure-resolution/recovery-policy.ts / Implement evaluateRecoveryPolicy
   - Action: add
   - Given: A StageFailure, the Attempt Log state, failureResolution config, allowed decisions.
   - When: `evaluateRecoveryPolicy(failure, worktreePath, config, allowedDecisions)` is called.
   - Then: Returns `RecoveryPolicyResult` with `decision: RecoveryDecision`, `reason: string`. If security-sensitive, returns `HANDOFF_TO_HUMAN`. If budget exhausted, returns `HANDOFF_TO_HUMAN`. Otherwise returns the agent's recommended decision if allowed.
   - Notes: The agent's recommended decision comes from the RecoveryArtifact. This function is called after parsing the artifact, with the agent's recommendation as input.
   - Constraints: Must check `recoveryBudgetForFailure` from I-02.

   ```ts
   import { recoveryBudgetForFailure, computeFailureFingerprint } from "../shared/attempt-log";
   import type { RecoveryDecision } from "./types";

   export interface RecoveryPolicyParams {
     readonly failure: StageFailure;
     readonly worktreePath: string;
     readonly fingerprint: string;
     readonly maxAttempts: number;
     readonly agentRecommendedDecision: RecoveryDecision;
     readonly allowedDecisions: readonly RecoveryDecision[];
   }

   export interface RecoveryPolicyResult {
     readonly decision: RecoveryDecision;
     readonly reason: string;
   }

   export async function evaluateRecoveryPolicy(
     params: RecoveryPolicyParams
   ): Promise<RecoveryPolicyResult> {
     if (isSecuritySensitiveFailure(params.failure)) {
       return { decision: "HANDOFF_TO_HUMAN", reason: "Security-sensitive failure — AI recovery bypassed" };
     }

     const budget = recoveryBudgetForFailure(params.worktreePath, params.fingerprint, params.maxAttempts);

     if (budget.exhausted) {
       return { decision: "HANDOFF_TO_HUMAN", reason: `Recovery budget exhausted (${budget.used}/${params.maxAttempts})` };
     }

     if (!params.allowedDecisions.includes(params.agentRecommendedDecision)) {
       return { decision: "HANDOFF_TO_HUMAN", reason: `Agent recommended ${params.agentRecommendedDecision} which is not allowed` };
     }

     if (params.agentRecommendedDecision === "FAIL_RUN") {
       return { decision: "FAIL_RUN", reason: "Agent recommended FAIL_RUN" };
     }

     return { decision: params.agentRecommendedDecision, reason: "Agent recommendation accepted" };
   }
   ```
   - Constraints: Use async/await (calls `recoveryBudgetForFailure` which reads a file synchronously but may become async later). Keep it async for future-proofing.

3. pourkit/failure-resolution/failure-resolution-agent.ts / Implement constructFailureResolutionPacket
   - Action: add
   - Given: A StageFailure (RebaseConflict) and the relevant context.
   - When: `constructFailureResolutionPacket(failure, context)` is called.
   - Then: Returns a `FailureResolutionPacket` with all fields populated from the failure and context.
   - Notes: For RebaseConflict, populate `conflictedPaths` and `failureSummary` from the error. For other failures the packet differs — this slice focuses on RebaseConflict.
   - Constraints: Must not depend on Effect.

   ```ts
   import { RebaseConflict, type FailureResolutionPacket, type StageFailure, type StageFailureTag, type RecoveryDecision } from "./types";

   export interface PacketContext {
     readonly stageName: string;
     readonly attemptNumber: number;
     readonly worktreePath: string;
     readonly branchName: string;
     readonly baseBranch: string;
     readonly maxAttempts: number;
     readonly allowedDecisions: readonly RecoveryDecision[];
     readonly artifactTarget: string;
   }

   export function constructFailureResolutionPacket(
     failure: RebaseConflict,
     context: PacketContext
   ): FailureResolutionPacket {
     return {
       failureType: "RebaseConflict" as StageFailureTag,
       stageName: context.stageName,
       attemptNumber: context.attemptNumber,
       worktreePath: context.worktreePath,
       branchName: context.branchName,
       baseBranch: context.baseBranch,
       conflictedPaths: failure.conflictedPaths,
       failureSummary: failure.message,
       maxAttempts: context.maxAttempts,
       allowedDecisions: context.allowedDecisions,
       artifactTarget: context.artifactTarget,
     };
   }
   ```

4. pourkit/failure-resolution/failure-resolution-agent.ts / Implement runFailureResolutionAgent
   - Action: add
   - Given: A FailureResolutionPacket, the FR agent config, execution provider, config, etc.
   - When: `runFailureResolutionAgent(options)` is called.
   - Then: Invokes the FR agent via `executionProvider.execute`, reads the artifact file, parses it with `parseRecoveryArtifact`, validates the decision with `validateRecoveryDecision`, evaluates policy with `evaluateRecoveryPolicy`, records recovery attempt in Attempt Log, returns the policy result.
   - Notes: Similar flow to `runConflictResolutionOnce` but with new artifact format and policy evaluation. The agent prompt should include the serialized FailureResolutionPacket.
   - Constraints: Must handle agent execution failure (timeout, sandbox error) → record as FailureResolutionAgentFailed recovery attempt.

   ```ts
   import { readFileSync, existsSync } from "fs";
   import { join } from "path";
   import { type ExecutionProvider } from "../execution/execution-provider";
   import { parseRecoveryArtifact, validateRecoveryDecision, FailureResolutionAgentFailed, type RecoveryDecision, type RecoveryArtifact, type StageFailure } from "./types";
   import { evaluateRecoveryPolicy, type RecoveryPolicyResult } from "./recovery-policy";
   import { writeAttemptLog, computeFailureFingerprint } from "../shared/attempt-log";
   import { type PourkitLogger } from "../shared/common";
   import { type PourkitConfig } from "../shared/config";
   import { resolvePromptTemplatePath } from "../shared/config";

   export interface RunFailureResolutionAgentOptions {
     executionProvider: ExecutionProvider;
     config: PourkitConfig;
     failure: RebaseConflict;
     packet: FailureResolutionPacket;
     packetContext: PacketContext;
     worktreePath: string;
     repoRoot: string;
     logger: PourkitLogger;
   }

   export type FailureResolutionAgentResult =
     | { status: "recovered"; decision: RecoveryDecision; artifact: RecoveryArtifact }
     | { status: "handoff"; decision: "HANDOFF_TO_HUMAN"; reason: string }
     | { status: "fail-run"; decision: "FAIL_RUN"; reason: string };

   export async function runFailureResolutionAgent(
     options: RunFailureResolutionAgentOptions
   ): Promise<FailureResolutionAgentResult> {
     const { executionProvider, config, failure, packet, packetContext, worktreePath, repoRoot, logger } = options;
     const frConfig = config.targets[0].strategy.failureResolution;
     const artifactPath = packet.artifactTarget;
     const fullArtifactPath = join(worktreePath, artifactPath);
     const fingerprint = computeFailureFingerprint("baseRefresh", "RebaseConflict");

     // Build prompt with serialized packet
     const prompt = [
       `# Failure Resolution: ${packet.failureType}`,
       "",
       "## Failure Context",
       "",
       "```json",
       JSON.stringify(packet, null, 2),
       "```",
       "",
       "## Instructions",
       "",
       `Write your resolution to: ${artifactPath}`,
       "Include a ```json block with: recoveryDecision, summary, changedFiles, verificationSummary (optional), verificationCommands (optional), notes (optional).",
       "",
       "Allowed decisions: " + packet.allowedDecisions.join(", "),
     ].join("\n");

     // Invoke agent
     const executionResult = await executionProvider.execute({
       stage: "failureResolution",
       agent: frConfig.agent,
       model: frConfig.model,
       prompt,
       target: config.targets[0],
       repoRoot,
       branchName: packet.branchName,
       sandbox: config.sandbox,
       autoApprove: true,
       worktreePath,
       artifactPath,
       artifacts: [],
       logger,
     });

     if (!executionResult.success) {
       await writeRecoveryAttempt(worktreePath, "failure", fingerprint, `Agent execution failed: ${executionResult.error}`);
       return { status: "handoff", decision: "HANDOFF_TO_HUMAN", reason: `Agent execution failed: ${executionResult.error}` };
     }

     // Read and parse artifact
     if (!existsSync(fullArtifactPath)) {
       await writeRecoveryAttempt(worktreePath, "failure", fingerprint, "Agent did not write artifact");
       return { status: "handoff", decision: "HANDOFF_TO_HUMAN", reason: "Agent did not write artifact" };
     }

     let artifact: RecoveryArtifact;
     try {
       const md = readFileSync(fullArtifactPath, "utf-8");
       artifact = parseRecoveryArtifact(md, artifactPath);
     } catch (error) {
       const reason = error instanceof Error ? error.message : "Failed to parse artifact";
       await writeRecoveryAttempt(worktreePath, "failure", fingerprint, reason);
       return { status: "handoff", decision: "HANDOFF_TO_HUMAN", reason };
     }

     // Validate decision
     const validation = validateRecoveryDecision(artifact, packet.allowedDecisions);
     if (!validation.valid) {
       await writeRecoveryAttempt(worktreePath, "failure", fingerprint, validation.reason!);
       return { status: "handoff", decision: "HANDOFF_TO_HUMAN", reason: validation.reason! };
     }

     // Evaluate policy
     const policyResult = await evaluateRecoveryPolicy({
       failure,
       worktreePath,
       fingerprint,
       maxAttempts: packet.maxAttempts,
       agentRecommendedDecision: validation.decision!,
       allowedDecisions: packet.allowedDecisions,
     });

     await writeRecoveryAttempt(worktreePath, policyResult.decision === "HANDOFF_TO_HUMAN" ? "handoff" : "success", fingerprint, policyResult.reason, artifactPath);

     if (policyResult.decision === "HANDOFF_TO_HUMAN") {
       return { status: "handoff", decision: "HANDOFF_TO_HUMAN", reason: policyResult.reason };
     }
     if (policyResult.decision === "FAIL_RUN") {
       return { status: "fail-run", decision: "FAIL_RUN", reason: policyResult.reason };
     }
     return { status: "recovered", decision: policyResult.decision as RecoveryDecision, artifact };
   }

   async function writeRecoveryAttempt(
     worktreePath: string,
     outcome: "success" | "failure" | "handoff",
     fingerprint: string,
     summary: string,
     artifactRef?: string
   ): Promise<void> {
     writeAttemptLog(worktreePath, {
       attemptType: "recovery",
       fingerprint,
       timestamp: new Date().toISOString(),
       stage: "baseRefresh",
       outcome,
       artifactRef,
       decision: outcome === "handoff" ? "HANDOFF_TO_HUMAN" : outcome === "success" ? "RETRY_STAGE" : undefined,
     });
   }
   ```
   - Constraints: Must match the execution pattern of other agent invocations.

5. pourkit/commands/issue-run.ts / Replace conflict path with FR agent flow
   - Action: modify
   - Given: The Base Refresh Effect exit handling (from I-04) receives a RebaseConflict failure.
   - When: A RebaseConflict occurs and `strategy.failureResolution` is configured.
   - Then: Construct FailureResolutionPacket, run `runFailureResolutionAgent`, handle result. If `recovered` with `RETRY_STAGE`, re-run Base Refresh via `runBaseRefreshAttempt`. If `handoff`, transition to human handoff. If `fail-run`, throw error.
   - Notes: Replace the entire `else if (refreshResult.status === "conflicted")` block. The old block checked `strategy.conflictResolution` and called `runConflictResolutionLoop`. The new block checks `strategy.failureResolution` and calls `runFailureResolutionAgent`.
   - Constraints: The non-conflict Base Refresh paths remain from I-04.

   ```ts
   // In startIssueRun, replace the conflicted handling:
   // Old code (to remove):
   // } else if (refreshResult.status === "conflicted") {
   //   if (strategy.conflictResolution && resolution.worktreePath) {
   //     ...
   //   }
   // }

   // New code:
   } else if (Exit.isFailure(exit)) {
     const failure = exit.cause;
     if (failure._tag === "Fail" && failure.error instanceof RebaseConflict) {
       await handleRebaseConflict(failure.error, {
         worktreePath: resolution.worktreePath!,
         branchName,
         target,
         config,
         issueNumber,
         issueProvider,
         executionProvider,
         repoRoot: ROOT,
         worktreeState,
         logger,
       });
     } else if (failure._tag === "Fail" && failure.error instanceof PublishedHistoryRisk) {
       await handlePublishedHistoryRisk(failure.error, {
         issueNumber,
         issueProvider,
         config,
         worktreePath: resolution.worktreePath!,
         worktreeState,
         logger,
       });
     } else {
       // Defect or unknown failure
       throw new Error(`Base refresh failed: unexpected error`);
     }
   }
   ```

   The `handleRebaseConflict` function should:
   - Check `strategy.failureResolution` is configured (it's required by I-01, but defensive check)
   - Construct packet, run FR agent
   - If recovered + RETRY_STAGE: call `runBaseRefreshAttempt` again. If success, invalidate state. If failure again, handoff.
   - If handoff: transition issue to human handoff
   - If fail-run: throw error

6. pourkit/commands/issue-run.ts / Add handleRebaseConflict and handlePublishedHistoryRisk helpers
   - Action: add
   - Given: RebaseConflict or PublishedHistoryRisk failure.
   - When: Called from startIssueRun.
   - Then: Execute appropriate recovery or handoff flow.
   - Notes: These are private module-level functions. Keep them focused.

   ```ts
   async function handleRebaseConflict(
     failure: RebaseConflict,
     context: {
       worktreePath: string;
       branchName: string;
       target: ResolvedTarget;
       config: PourkitConfig;
       issueNumber: number;
       issueProvider: IssueProvider;
       executionProvider: ExecutionProvider;
       repoRoot: string;
       worktreeState: WorktreeRunState | null;
       logger: PourkitLogger;
     }
   ): Promise<void> {
     const frConfig = context.target.strategy.failureResolution;
     if (!frConfig) {
       // Defensive — should not happen since failureResolution is required
       await transitionIssueToFailureState(context.issueProvider, context.issueNumber, context.config, "No failureResolution configured", context.logger);
       throw new Error("Base refresh conflicted: no failureResolution configured");
     }

     const maxAttempts = frConfig.failureLimits?.RebaseConflict ?? frConfig.maxAttemptsPerFailure;
     let attemptNumber = 0;

     while (attemptNumber < maxAttempts) {
       attemptNumber++;

       const packet = constructFailureResolutionPacket(failure, {
         stageName: "baseRefresh",
         attemptNumber,
         worktreePath: context.worktreePath,
         branchName: context.branchName,
         baseBranch: context.target.baseBranch,
         maxAttempts,
         allowedDecisions: ["RETRY_STAGE", "HANDOFF_TO_HUMAN", "FAIL_RUN"],
         artifactTarget: `.pourkit/.tmp/failure-resolution/attempt-${attemptNumber}.md`,
       });

       const result = await runFailureResolutionAgent({
         executionProvider: context.executionProvider,
         config: context.config,
         failure,
         packet,
         packetContext: { ... },
         worktreePath: context.worktreePath,
         repoRoot: context.repoRoot,
         logger: context.logger,
       });

       if (result.status === "handoff") {
         await transitionIssueToFailureState(context.issueProvider, context.issueNumber, context.config, result.reason, context.logger);
         throw new Error(result.reason);
       }

       if (result.status === "fail-run") {
         throw new Error(result.reason);
       }

       // recovered with RETRY_STAGE — re-run Base Refresh
       const retryExit = await runBaseRefreshAttempt({
         worktreePath: context.worktreePath,
         baseBranch: context.target.baseBranch,
         localGitBaseRef: `origin/${context.target.baseBranch}`,
         logger: context.logger,
       });

       if (Exit.isSuccess(retryExit)) {
         // Base Refresh succeeded after recovery
         if (context.worktreeState?.completedStages.builder) {
           const invalidatedState = invalidateAfterBaseRefresh(context.worktreeState);
           writeWorktreeRunState(context.worktreePath, invalidatedState);
         }
         return; // success — continue issue run
       }

       // RETRY_STAGE failed again — update failure for next loop iteration
       const retryFailure = retryExit.cause;
       if (retryFailure._tag === "Fail" && retryFailure.error instanceof RebaseConflict) {
         failure = retryFailure.error; // update for next loop
       } else {
         // Not a RebaseConflict — handoff
         await transitionIssueToFailureState(context.issueProvider, context.issueNumber, context.config, "Base refresh failed after recovery attempt", context.logger);
         throw new Error("Base refresh failed after recovery attempt");
       }
     }

     // Exhausted
     await transitionIssueToFailureState(context.issueProvider, context.issueNumber, context.config, `Base refresh recovery exhausted after ${maxAttempts} attempts`, context.logger);
     throw new Error(`Base refresh recovery exhausted after ${maxAttempts} attempts`);
   }
   ```

7. pourkit/commands/issue.test.ts / Add FR agent integration regression tests
   - Action: add test
   - Given: Mocked execution provider and attempt log.
   - When: Base Refresh conflicts and strategy.failureResolution is configured.
   - Then: FR agent is invoked, recovery flows correctly.
   - Notes: Test RETRY_STAGE success, HANDOFF_TO_HUMAN, FAIL_RUN, exhausted budget.

   ```ts
   it("invokes Failure Resolution Agent when Base Refresh conflicts", async () => {
     // Setup: stale worktree, strategy.failureResolution configured
     // Mock refreshStaleIssueBranch to return conflicted
     // Mock executionProvider.execute to produce valid RecoveryArtifact
     // Verify: runFailureResolutionAgent is called with correct packet
   });

   it("re-runs Base Refresh after successful RETRY_STAGE decision", async () => {
     // Mock first refresh → conflicted
     // Mock FR agent → RETRY_STAGE
     // Mock second refresh → refreshed
     // Verify: invalidateAfterBaseRefresh called, builder preserved
   });

   it("handles PublishedHistoryRisk without invoking FR agent", async () => {
     // Mock refreshStaleIssueBranch to return refused-published-history
     // Verify: FR agent not invoked, human handoff transitioned
   });

   it("transitions to human handoff when recovery budget exhausted", async () => {
     // Setup: FR agent keeps returning RETRY_STAGE but Base Refresh keeps failing
     // maxAttemptsPerFailure = 1
     // Verify: after 1 retry, issue transitions to ready-for-human
   });
   ```

8. pourkit/failure-resolution/failure-resolution-agent.test.ts / Add FR agent unit tests
   - Action: add test
   - Given: Valid RebaseConflict and packet.
   - When: `runFailureResolutionAgent` is called.
   - Then: Returns correct result based on agent output.
   - Notes: Test agent success with valid artifact, agent execution failure, missing artifact, invalid artifact, unsupported decision.

   ```ts
   it("returns recovered when agent writes valid RecoveryArtifact with RETRY_STAGE", async () => {
     // Mock executionProvider.execute → success
     // Write valid RecoveryArtifact to expected path
     // Verify: result.status === "recovered", decision === "RETRY_STAGE"
   });

   it("returns handoff when agent execution fails", async () => {
     // Mock executionProvider.execute → failure
     // Verify: result.status === "handoff"
   });

   it("returns handoff when artifact has missing JSON block", async () => {
     // Mock executionProvider.execute → success, write markdown without JSON block
     // Verify: result.status === "handoff"
   });
   ```

9. pourkit/failure-resolution/recovery-policy.test.ts / Add policy tests
   - Action: add test
   - Given: Various failure types and budget states.
   - When: `evaluateRecoveryPolicy` is called.
   - Then: Returns correct policy decision.
   - Notes: Test security-sensitive bypass, budget exhaustion, agent decision override.

   ```ts
   it("returns HANDOFF_TO_HUMAN for PublishedHistoryRisk", async () => {
     const result = await evaluateRecoveryPolicy({ ... });
     expect(result.decision).toBe("HANDOFF_TO_HUMAN");
   });

   it("returns HANDOFF_TO_HUMAN when budget exhausted", async () => {
     // Set up Attempt Log with maxAttempts used
     const result = await evaluateRecoveryPolicy({ ... });
     expect(result.decision).toBe("HANDOFF_TO_HUMAN");
   });

   it("accepts agent recommendation when budget available and decision allowed", async () => {
     const result = await evaluateRecoveryPolicy({ ... });
     expect(result.decision).toBe("RETRY_STAGE");
   });
   ```

10. pourkit/commands/issue.test.ts / Regression — non-conflict Base Refresh tests still pass
    - Action: verify (regression)
    - Given: Existing Base Refresh tests (refreshed, skipped-current, refused-published-history).
    - When: Tests run.
    - Then: All pass unchanged.
    - Notes: The non-conflict paths should be unaffected by the FR agent changes.
    - Constraints: Do not modify existing test assertions for happy-path Base Refresh.

## Contracts / interfaces

See I-03 for `FailureResolutionPacket`, `RecoveryArtifact`, `RecoveryDecision`, `StageFailure` types.
See I-02 for `writeAttemptLog`, `computeFailureFingerprint`, `recoveryBudgetForFailure`.
See I-04 for `runBaseRefreshAttempt`, `BaseRefreshSuccess`.

New types:

```ts
// failure-resolution-agent.ts
export interface RunFailureResolutionAgentOptions {
  executionProvider: ExecutionProvider;
  config: PourkitConfig;
  failure: RebaseConflict;
  packet: FailureResolutionPacket;
  worktreePath: string;
  repoRoot: string;
  logger: PourkitLogger;
}

export type FailureResolutionAgentResult =
  | { status: "recovered"; decision: RecoveryDecision; artifact: RecoveryArtifact }
  | { status: "handoff"; decision: "HANDOFF_TO_HUMAN"; reason: string }
  | { status: "fail-run"; decision: "FAIL_RUN"; reason: string };

// recovery-policy.ts
export interface RecoveryPolicyParams {
  readonly failure: StageFailure;
  readonly worktreePath: string;
  readonly fingerprint: string;
  readonly maxAttempts: number;
  readonly agentRecommendedDecision: RecoveryDecision;
  readonly allowedDecisions: readonly RecoveryDecision[];
}

export interface RecoveryPolicyResult {
  readonly decision: RecoveryDecision;
  readonly reason: string;
}
```

## Edge cases

- FR agent writes artifact with empty changedFiles: valid (no files changed).
- FR agent recommends unsupported decision (RESUME_FROM_STAGE): policy returns HANDOFF_TO_HUMAN with reason.
- FR agent execution time out: treated as `FailureResolutionAgentFailed`, recorded as recovery failure, policy evaluated.
- RETRY_STAGE succeeds but invalidation was already done: idempotent.
- Consecutive recovery attempts all fail: exhausted after maxAttempts.

## Validation

- New behavior test: FR agent invoked for RebaseConflict, returns recovered/handoff/fail-run.
- New behavior test: PublishedHistoryRisk bypasses FR agent → human handoff.
- New behavior test: Recovery budget exhaustion → human handoff.
- Regression contract test: Existing issue.test.ts non-conflict Base Refresh tests pass.
- Regression contract test: Existing `invalidateAfterBaseRefresh` behavior preserved.

## Out of scope

- Host-run verification after recovery — FR agent runs its own verification. Source: DEC-0026, DEC-0027.
- Attempt Log rotation — out of scope per PRD-037.
- Non-Base-Refresh failures — deferred to Slice 2.

## Priority

feature

## Acceptance criteria

- [ ] FR agent is invoked via `strategy.failureResolution` when Base Refresh conflicts.
- [ ] FailureResolutionPacket is constructed from RebaseConflict context and passed to agent.
- [ ] RecoveryArtifact is parsed and validated; invalid artifacts result in handoff.
- [ ] Recovery policy evaluates agent recommendation, budget, and security sensitivity.
- [ ] RETRY_STAGE re-runs Base Refresh; after success, `invalidateAfterBaseRefresh` is called.
- [ ] HANDOFF_TO_HUMAN transitions issue to human handoff.
- [ ] FAIL_RUN aborts the run with an error.
- [ ] PublishedHistoryRisk goes straight to human handoff without agent invocation.
- [ ] Recovery attempts are recorded in Attempt Log with proper fingerprint scoping.
- [ ] Recovery budget exhaustion results in human handoff.
- [ ] Existing non-conflict Base Refresh tests pass unchanged.

## Blocked by

- #75 (PRD-037 / I-01: strategy.failureResolution config schema)
- #77 (PRD-037 / I-03: Failure resolution domain types and validation)
- #78 (PRD-037 / I-04: Effect runtime and Base Refresh Stage Attempt)

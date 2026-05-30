# Decisions

Locked decisions are append-oriented. Do not silently rewrite them.

## Decision Log

### DEC-0001 — Control-plane rewrite first, not full rewrite

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Adopt Effect v3 as a host-side control plane first. Keep old implementation functions as adapters initially. Rewrite internals only where typed services and testability pay off.

Rationale:
Full rewrite would be too risky and slow. Narrow Effect island proves the architecture without committing to a complete migration.

Implications:
- Old implementation functions serve as adapters behind Effect service interfaces.
- Rewrite decisions driven by testability and failure-control value, not stylistic consistency.

### DEC-0002 — Effect adoption optimizes for workflow confidence and failure control, not stylistic consistency

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Use Effect where it directly improves typed failure routing, recovery orchestration, or test isolation. Do not force Effect into every module for consistency.

Rationale:
The primary problem is brittleness and low failure confidence — not lack of functional purity or algebraic effects.

Implications:
- Mixed codebase: Effect islands in control-plane modules, plain TypeScript elsewhere.
- No blanket lint rules requiring Effect everywhere.

### DEC-0003 — Effect Control Plane is host-side orchestration/control model

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Effect Control Plane owns typed failures, services/layers, failure policy, retry/resume/repair/handoff decisions. Pourkit remains the orchestrator.

Rationale:
Clear separation: host controls orchestration and recovery decisions; AI agents perform repair work within defined boundaries.

Implications:
- Control plane lives in Pourkit CLI, not AI prompts.
- AI agents never decide merge, close, force push, or skip review.

### DEC-0004 — Introduce Effect immediately but narrowly around Base Refresh stage/recovery loop

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
First Effect island is the Base Refresh stage and its recovery loop. Temporary local runtime boundary inside existing async runner is acceptable. Later move `runPromiseExit` to CLI edge.

Rationale:
Base Refresh is the smallest stage that exercises the full control-plane architecture (typed failure, AI recovery, state logging) and replaces existing conflict resolution.

Implications:
- Effect runtime created per-run inside the async Issue Runner initially.
- Later PR may move Effect runtime to CLI application edge.

### DEC-0005 — Recovery unit is Stage Attempt

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
A Stage Attempt represents one try at one normal pipeline stage. It is the fundamental recovery unit.

Rationale:
Clear lifecycle: attempt → failure → policy evaluation → recovery or handoff.

Implications:
- Each pipeline stage execution creates a Stage Attempt record.
- Stage Attempt outcome determines next control-plane action.

### DEC-0006 — Recovery Attempt attaches to failed Stage Attempt

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
A Recovery Attempt is created when the control plane dispatches recovery for a failed Stage Attempt. It is attached to and scoped to that Stage Attempt.

Rationale:
Clear parent-child relationship preserves failure audit trail without recursive complexity.

Implications:
- Recovery Attempt inherits failure context from parent Stage Attempt.
- Recovery Attempt failures record against the original Stage Attempt's budget.

### DEC-0007 — Failure Resolution Agent is one general AI agent

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Replace dedicated Conflict Resolution Agent with one general Failure Resolution Agent invoked by Pourkit for allowed blocking/critical typed failures.

Rationale:
Single repair-crew abstraction is simpler than per-stage specialized agents. The agent receives structured context describing the failure and acts accordingly.

Implications:
- `strategy.conflictResolution` is removed.
- Failure Resolution Agent handles RebaseConflict, RecoveryArtifactInvalid, and future typed failures.
- Agent is invoked only for failures where policy allows AI repair.

### DEC-0008 — Failure Resolution Agent is mandatory under strategy.failureResolution, not global

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
`strategy.failureResolution` is a required strategy-level configuration. It is not a global config. `strategy.conflictResolution` should fail config validation with a clear migration message.

Rationale:
Failure resolution policy belongs at strategy scope because different targets/lanes may have different recovery needs. Pourkit is pre-stable enough to break config compatibility with a clear message.

Implications:
- Every strategy must configure `strategy.failureResolution`.
- Existing strategies using `strategy.conflictResolution` will fail validation.
- Migration message should point user to replace `conflictResolution` with `failureResolution`.

### DEC-0009 — strategy.failureResolution supports maxAttemptsPerFailure fallback plus per-failure failureLimits overrides

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
`strategy.failureResolution` has a default `maxAttemptsPerFailure` that applies to all failures unless overridden by per-failure `failureLimits`.

Rationale:
Sensible default prevents infinite recovery loops. Per-failure overrides allow tighter limits for risky failures or looser limits for transient issues.

Implications:
- Config schema: `strategy.failureResolution.maxAttemptsPerFailure` (number, default TBD).
- Config schema: `strategy.failureResolution.failureLimits` (optional map of failure type → max attempts).
- First slice should define reasonable defaults.

### DEC-0010 — Failure Resolution Agent receives structured Failure Resolution Packet

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
The host sends a structured FailureResolutionPacket to the agent — not loose prompt text. The packet includes failure type, context, worktree path, stage, attempt number, and policy limits.

Rationale:
Structured input improves agent reliability and allows schema validation on both sides.

Implications:
- FailureResolutionPacket must be defined as a typed schema (likely Effect Schema or Zod).
- Future: can be serialized/deserialized across runtime boundaries.

### DEC-0011 — Failure Resolution Agent writes structured Recovery Artifact as markdown with required parseable JSON block

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Agent output is a markdown file under `.pourkit/.tmp/failure-resolution/attempt-{n}.md` containing a narrative summary and a required parseable JSON block with structured fields.

Rationale:
Markdown is agent-friendly. Embedded JSON block enables host-side programmatic parsing without NLP.

Implications:
- Host validates JSON block schema after agent returns.
- Artifact path is inside `.tmp` — not runner-owned durable state.
- RecoveryArtifact schema includes at minimum: recoveryDecision, summary, changedFiles, and optional fields.

### DEC-0012 — Agent may recommend next Recovery Decision, but Pourkit decides officially

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
The Failure Resolution Agent includes a recommended `recoveryDecision` in its artifact. The host (Pourkit) evaluates and makes the final decision.

Rationale:
Host retains full orchestration authority. Agent is a repair specialist, not a decision-maker.

Implications:
- Host may override agent recommendation based on policy, budget, or safety checks.
- RecoveryDecision enforcement happens in host control plane.

### DEC-0013 — RecoveryDecision enum includes RETRY_STAGE, RESUME_FROM_STAGE, MARK_STAGE_COMPLETE, HANDOFF_TO_HUMAN, FAIL_RUN

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
The RecoveryDecision enum supports: RETRY_STAGE (retry the same stage), RESUME_FROM_STAGE (skip to next stage), MARK_STAGE_COMPLETE (treat as done), HANDOFF_TO_HUMAN (escalate), FAIL_RUN (abort run).

Rationale:
Each decision maps to a distinct control-plane action. First slice may not implement all variants.

Implications:
- PRD should specify which enum values are in scope for first slice.
- HANDOFF_TO_HUMAN is the safe default when policy cannot decide.

### DEC-0014 — Human Handoff occurs when safe automated recovery is unavailable or exhausted

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Human Handoff is triggered when safe automated recovery is unavailable (e.g., security-sensitive failure) or when recovery attempts are exhausted. Not after every possible action is attempted.

Rationale:
Automated recovery is valuable; handoff should be reserved for cases where AI cannot safely proceed, not as a default after each attempt.

Implications:
- Recovery policy attempts automated recovery within configured limits before handoff.
- Some failures bypass automated recovery entirely (see DEC-0015).

### DEC-0015 — Security-sensitive failures go straight to Human Handoff

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Failures involving auth, secrets, permissions, payments, destructive data actions, or privacy-sensitive data go directly to Human Handoff without AI recovery attempt.

Rationale:
Security-sensitive contexts should never be entrusted to automated AI repair.

Implications:
- SafetyFailure taxonomy category routes directly to HANDOFF_TO_HUMAN.
- The control plane must detect and classify these failures before dispatching to AI.

### DEC-0016 — Defects mostly do not go to Failure Resolution Agent

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Defects (programming errors / unexpected exceptions in Pourkit code) do not route through Failure Resolution Agent. Expected typed StageFailures route through policy. Defects capture Exit/Cause diagnostics and fail/handoff safely.

Rationale:
Defects indicate a bug in Pourkit itself — an AI agent cannot meaningfully repair infrastructure code failures.

Implications:
- Defect handling captures diagnostics and either crashes with clear output or hands off to human.
- External adapter failures should be converted to typed StageFailures when classifiable.

### DEC-0017 — Worktree Run State remains small; append-only Attempt Log records history

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Worktree Run State (`.pourkit/state.json`) stays minimal — just enough for resume decisions. The append-only Attempt Log records all failure and recovery history for diagnosis, resume, and loop prevention.

Rationale:
Separation of concerns: state.json for quick resume queries; Attempt Log for full audit trail.

Implications:
- Attempt Log is the durable record for post-mortem analysis.
- Run State contains only pointers/status needed for immediate resume.

### DEC-0018 — Attempt Log path is .pourkit/attempt-log.jsonl inside Worktree

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Attempt Log lives at `.pourkit/attempt-log.jsonl` inside the Worktree. It is runner-owned resumable metadata like `.pourkit/state.json`, not under `.tmp`.

Rationale:
Durable metadata belongs in the Worktree alongside state.json. `.tmp` is for ephemeral artifacts.

Implications:
- `.pourkit/attempt-log.jsonl` is preserved across sessions in the Worktree.
- Runner reads Attempt Log during resume to detect loop conditions and previous failures.

### DEC-0019 — Attempt Log records original stage failure and recovery failures separately

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Each Attempt Log entry distinguishes original stage failure from recovery attempt failures. Recovery failures consume budget for the original failure fingerprint.

Rationale:
Clear failure lineage. Budget is per original failure, not per attempt — prevents infinite recovery chains while preserving full history.

Implications:
- Each entry includes: attempt type (stage|recovery), failure fingerprint, timestamp, outcome.
- Recovery budget tracks against original failure fingerprint, not individual recovery attempt.

### DEC-0020 — No nested recovery tree

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
A failure during a Recovery Attempt is recorded as a Recovery Attempt failure attached to the original Stage Attempt. There is no further nested recovery.

Rationale:
Prevents infinite recursion. A recovery failure means the automated approach cannot resolve the issue; proceed to Human Handoff or FAIL_RUN.

Implications:
- Recovery Attempt failures count against the original failure budget.
- After recovery attempt failure, control plane evaluates next action (RETRY_STAGE, HANDOFF_TO_HUMAN, etc.).

### DEC-0021 — First implementation slice is Base Refresh + Failure Resolution Agent

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
The first slice implements Effect control plane for Base Refresh stage with Failure Resolution Agent. This replaces existing conflict resolution and exercises the full architecture without rewriting all stages.

Rationale:
Base Refresh is small, self-contained, and has existing conflict/repair logic to replace. Proves the control-plane pattern before expanding to other stages.

Implications:
- All other stages remain unchanged in first slice.
- First slice scope includes: Effect dependency, strategy.failureResolution config, Attempt Log, failure-resolution domain module, RecoveryDecision, FailureResolutionPacket, RecoveryArtifact, conflict path rewrite.

### DEC-0022 — Base Refresh becomes first-class Stage Attempt

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Base Refresh is modeled as a formal Stage Attempt with typed failure outcomes, not as a side-effect branch in runner code.

Rationale:
Consistent with the control-plane model. Base Refresh can fail with specific StageFailure types (RebaseConflict, PublishedHistoryRisk, etc.) and go through policy evaluation.

Implications:
- Base Refresh has a defined StageAttempt lifecycle: start → attempt → success/failure.
- Failure routes through control-plane policy for recovery decision.

### DEC-0023 — RebaseConflict is handled through Failure Resolution Agent

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
When Base Refresh fails with RebaseConflict, the control plane dispatches a Failure Resolution Agent invocation via `strategy.failureResolution`. The agent repairs conflicted files and produces a RecoveryArtifact.

Rationale:
Replaces the now-removed Conflict Resolution Agent. Single AI repair crew for all allowed failures.

Implications:
- Host owns git state transitions (git add, git rebase --continue) after AI repair.
- Host validates RecoveryArtifact and git state before proceeding.

### DEC-0024 — For targetBranch moving (future parallel queue scenario), Pourkit should refresh stale Worktree before review/finalization/PR/merge as needed

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
In a future parallel queue scenario where targetBranch moves between issue processing, Pourkit should refresh stale Worktrees before downstream stages. If clean rebase, no human handoff.

Rationale:
Stale Worktrees cause downstream failures. Automated refresh prevents unnecessary handoffs.

Implications:
- Out of scope for first slice but architecture must support it.
- Base Refresh mechanism extends naturally to pre-stage staleness checks.

### DEC-0025 — After successful Base Refresh or conflict recovery, keep Builder complete but invalidate Review and everything downstream

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
When Base Refresh or conflict recovery succeeds, Builder output remains valid. Review and all downstream stages (Refactor, Finalizer, PR, merge) are invalidated and must rerun.

Rationale:
Rebase changes the base commit. Builder's code changes still apply, but Review may need to re-evaluate against the new base. Downstream stages depend on Review output.

Implications:
- Run state marks Review/downstream as invalidated.
- Queue loop or issue runner reruns Reviewer automatically.

### DEC-0026 — Conflict Repair Verification should be AI-run inside Failure Resolution Agent recovery context, not host-run

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
The Failure Resolution Agent performs conflict repair verification within its own recovery context (e.g., running build or test commands). Host validates artifact/protocol/git state but does not run verification commands.

Rationale:
Host is control plane, AI is repair crew, Worktree is target. Verification needs context about the repair, which the AI has.

Implications:
- Host validates: RecoveryArtifact parseable, git state clean, required files present.
- AI reports verification results in RecoveryArtifact.
- Verification commands generally belong to issue-working agents, not host recovery (see DEC-0027).

### DEC-0027 — Verification commands generally belong to issue-working agents, not host recovery

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
Running verification commands (build, test, lint) during recovery is the Failure Resolution Agent's responsibility when appropriate. The host does not run verification as part of recovery validation.

Rationale:
Host's job is orchestration and policy enforcement. Agent has context to determine what verification is meaningful after its repair.

Implications:
- RecoveryArtifact may include verification results from AI-run commands.
- Host validates git state and artifact schema, not command outputs.
- Base Refresh conflict recovery is special: agent may run verification relevant to the conflict resolution.

### DEC-0028 — Failure Resolution Agent failure is its own Recovery Attempt failure attached to original Stage Attempt

Status: locked
Date: 2026-05-30
Source: Grill session 2026-05-30-effect-control-plane-failure-resolution

Decision:
If the Failure Resolution Agent itself fails (timeout, malformed artifact, agent error), that failure is recorded as a Recovery Attempt failure attached to the original Stage Attempt.

Rationale:
Consistent with DEC-0006 (Recovery Attempt attachment) and DEC-0020 (no nested recovery). The control plane then evaluates next action based on remaining budget.

Implications:
- `FailureResolutionAgentFailed` is a StageFailure type in the taxonomy.
- Recovery budget consumed. If exhausted, proceed to Human Handoff.
- First slice should include this failure type and handling.

### Superseded Decisions

None yet.

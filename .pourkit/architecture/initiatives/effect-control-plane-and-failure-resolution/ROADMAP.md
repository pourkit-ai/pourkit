# Roadmap

## Roadmap Policy

Only stable, executable slices become PRDs.

## Phases / Slices

### Slice 1 — Base Refresh + Failure Resolution Agent

Status: active
Priority: 1
PRD: `prds/PRD-001-base-refresh-failure-resolution-agent/PRD.md`

Scope:
- Add Effect dependency; narrow Effect island for Base Refresh control.
- Add required `strategy.failureResolution` config; validate and reject `strategy.conflictResolution` with migration message.
- Add Attempt Log module; path `.pourkit/attempt-log.jsonl`.
- Add failure-resolution domain module with minimal StageFailure taxonomy: RebaseConflict, PublishedHistoryRisk, RecoveryArtifactInvalid, FailureResolutionAgentFailed.
- Add RecoveryDecision, FailureResolutionPacket, RecoveryArtifact parser/validator.
- Replace `runConflictResolutionLoop` usage in Base Refresh conflict path with generic Failure Resolution Agent invocation via `strategy.failureResolution`.
- Agent artifact path `.pourkit/.tmp/failure-resolution/attempt-{n}.md`.
- Successful refresh/recovery invalidates review/downstream and reruns Reviewer.
- PublishedHistoryRisk and security-sensitive failures bypass AI to Human Handoff.

Non-goals:
- Full issue runner rewrite to Effect
- Full queue runner rewrite
- Generic worktree recovery beyond Base Refresh
- Parallel queue execution
- All StageFailure categories
- Full service/layer refactor
- Host-run verification (except legacy behavior being replaced by AI-run recovery verification)

Dependencies:
- strategy.failureResolution config schema design
- Effect v3 dependency addition
- FailureResolutionAgent integration point in current runner architecture

---

### Slice 2 — Expanded failure taxonomy and generic worktree recovery

Status: candidate
Priority: 2

Scope:
- Expand StageFailure taxonomy across more pipeline stages (GitHubFailure, CheckFailure, ConfigFailure, SafetyFailure categories).
- Add generic worktree recovery for non-Base-Refresh failures.
- Tighten RecoveryDecision implementation for broader stage coverage.

Non-goals:
- Full CLI Effect rewrite (still incremental)
- Parallel queue execution

---

### Slice 3 — CLI edge runtime boundary migration

Status: candidate
Priority: 3

Scope:
- Move Effect runtime from local Issue Runner boundary to CLI application edge (`runPromiseExit`).
- Remove temporary local runtime boundary.
- Ensure all control-plane flows use shared Effect runtime.

Non-goals:
- Changing control-plane architecture
- Adding new stages to Effect migration

---

### Slice 4 — Queue / full Issue Runner Effect expansion

Status: candidate
Priority: 4

Scope:
- Apply Effect control plane to Queue Loop.
- Expand Effect coverage to full Issue Runner stages (Reviewer, Refactor, Finalizer, PR/merge).
- Full service/layer refactor where testability payoff is high.

Non-goals:
- Parallel queue execution (separate initiative)

---

## Deferred

- Parallel queue execution — independent architectural concern, not needed for control-plane proof.
- Full service/layer refactor of entire CLI — only justified after proving control-plane value.

## Slice Dependencies

| Slice | Depends On | Unlocks |
|-------|-----------|---------|
| 1 (Base Refresh + Failure Resolution Agent) | — | Slices 2-4 |
| 2 (Expanded taxonomy) | Slice 1 | Broader failure coverage |
| 3 (Runtime boundary migration) | Slice 1-2 | Cleaner Effect architecture |
| 4 (Queue / full runner) | Slices 1-3 | Full control-plane coverage |

# Extractions

## Locked Decisions

See also `DECISIONS.md` in initiative root for full decision records (DEC-0001 through DEC-0028).

High-level grouping:

- **Foundation**: DEC-0001 (control-plane first), DEC-0002 (optimize for confidence over style), DEC-0003 (host-side orchestration model)
- **Boundary**: DEC-0004 (narrow immediate Effect island), DEC-0005 (recovery unit = Stage Attempt), DEC-0006 (Recovery Attempt attachment)
- **Agent model**: DEC-0007 (one general Failure Resolution Agent), DEC-0008 (mandatory, not global), DEC-0009 (maxAttemptsPerFailure + per-failure overrides)
- **Protocol**: DEC-0010 (structured Packet), DEC-0011 (structured Recovery Artifact), DEC-0012 (host decides officially), DEC-0013 (RecoveryDecision enum)
- **Safety**: DEC-0014 (Human Handoff timing), DEC-0015 (security-sensitive straight to handoff), DEC-0016 (defects bypass agent)
- **State**: DEC-0017 (Attempt Log small, append-only), DEC-0018 (path = .pourkit/attempt-log.jsonl), DEC-0019 (separate recovery budget per fingerprint), DEC-0020 (no nested recovery tree)
- **First slice**: DEC-0021 (Base Refresh + Failure Resolution Agent), DEC-0022 (Base Refresh = Stage Attempt), DEC-0023 (RebaseConflict through agent), DEC-0024 (targetBranch moving)
- **Post-recovery**: DEC-0025 (invalidate review/downstream), DEC-0026 (AI-run conflict verification), DEC-0027 (verification commands belong to issue agents), DEC-0028 (agent failure is attached Recovery Attempt)

## Open Questions

1. **RecoveryArtifact JSON schema exactness**: What fields, types, and required/optional structure? Decide in PRD.
2. **RecoveryDecision enum for first slice**: Which enum values implemented? Discussion included RETRY_STAGE, RESUME_FROM_STAGE, MARK_STAGE_COMPLETE, HANDOFF_TO_HUMAN, FAIL_RUN. First slice may not need all.
3. **Runtime boundary migration**: Timeline for moving `runPromiseExit` to CLI edge? Deferred.
4. **Full StageFailure taxonomy timing**: When to expand beyond GitFailure/AgentExecutionFailure/ArtifactFailure categories defined for first slice?
5. **Failure resolution budget defaults**: Exact defaults for `maxAttemptsPerFailure`? Config schema design deferred to PRD.

## Architectural Invariants

1. Host (Pourkit) always decides recovery decision — AI recommends, host decides.
2. Worktree is the repair target — AI edits worktree files, host owns git state transitions.
3. Security-sensitive failures bypass AI repair entirely.
4. Defects (programming errors in Pourkit) do not route through Failure Resolution Agent.
5. Attempt Log is append-only, runner-owned, inside Worktree.
6. Recovery budget consumed per original failure fingerprint, not per attempt.
7. Base Refresh is a first-class Stage Attempt.
8. After successful refresh/recovery, Review and downstream stages are invalidated and rerun.

## Candidate Slices

### First Slice — Ready

**Base Refresh + Failure Resolution Agent**

Scope:
- Add Effect dependency; narrow Effect island for Base Refresh control.
- Add required `strategy.failureResolution` config; reject `strategy.conflictResolution` with migration message.
- Add Attempt Log module; path `.pourkit/attempt-log.jsonl`.
- Add failure-resolution domain module with minimal StageFailure taxonomy: RebaseConflict, PublishedHistoryRisk, RecoveryArtifactInvalid, FailureResolutionAgentFailed.
- Add RecoveryDecision, FailureResolutionPacket, RecoveryArtifact parser/validator.
- Replace `runConflictResolutionLoop` usage in Base Refresh conflict path with generic Failure Resolution Agent invocation via `strategy.failureResolution`.
- Agent artifact path `.pourkit/.tmp/failure-resolution/attempt-{n}.md`.
- Successful refresh/recovery invalidates review/downstream and reruns Reviewer.
- PublishedHistoryRisk and security-sensitive failures bypass AI to Human Handoff.

Non-goals: Full issue runner rewrite, full queue runner rewrite, generic worktree recovery beyond Base Refresh, parallel queue execution, all StageFailure categories, full service/layer refactor, host-run verification.

### Future Slices — Candidate

- **Slice 2: Broader failure taxonomy / worktree recovery**. Expand StageFailure taxonomy across more stages; add generic worktree recovery for non-Base-Refresh failures.
- **Slice 3: CLI edge runtime boundary migration**. Move Effect runtime to CLI edge (`runPromiseExit`), remove temporary local runtime boundary.
- **Slice 4: Queue / full Issue Runner Effect expansion**. Apply Effect control plane to queue loop and full issue runner stages.

### Deferred Slices
- Parallel queue execution.
- Full service/layer refactor of entire CLI.

## Risks

1. **Scope creep**: Temptation to rewrite more than Base Refresh in first slice. Guarded by explicit non-goals.
2. **Effect learning curve**: Team familiarity with Effect v3 may slow implementation. Mitigated by narrow first slice.
3. **Config migration**: Breaking change from `strategy.conflictResolution` to `strategy.failureResolution`. Mitigated by clear migration message.
4. **AI recovery quality**: Failure Resolution Agent may produce invalid or harmful recovery artifacts. Mitigated by structured artifact validation and host owning git state.

## Deferred Work

- Full StageFailure taxonomy for all pipeline stages.
- Generic worktree recovery beyond Base Refresh.
- Effect migration of queue runner.
- Effect migration of full issue runner stages.
- Parallel queue execution.
- Full service/layer refactor of CLI internals.
- Host-run verification (explicitly rejected — AI runs recovery verification).
- Runtime boundary migration to CLI edge.

## Terminology Updates

| Term | Description |
|------|-------------|
| Effect Control Plane | Host-side orchestration/control model using Effect v3: typed failures, services/layers, failure policy, retry/resume/repair/handoff decisions |
| Stage Attempt | One try at one normal pipeline stage; the recovery unit |
| Recovery Attempt | A recovery action attached to a failed Stage Attempt |
| Failure Resolution Agent | AI repair crew invoked for allowed typed failures; replaces Conflict Resolution Agent |
| FailureResolutionPacket | Structured input passed to Failure Resolution Agent describing the failure |
| RecoveryArtifact | Structured markdown with parseable JSON block produced by Failure Resolution Agent |
| Attempt Log | Append-only JSONL file at `.pourkit/attempt-log.jsonl` recording failures and recovery attempts |
| Human Handoff | Safe fallback when automated recovery unavailable or exhausted |
| RecoveryDecision | Enum: RETRY_STAGE, RESUME_FROM_STAGE, MARK_STAGE_COMPLETE, HANDOFF_TO_HUMAN, FAIL_RUN |
| Base Refresh (first-class) | Runner-owned rebase step now modeled as a Stage Attempt with typed failure |

## ADR Candidates

- ADR-001: Effect adoption strategy — narrow control-plane first, not full rewrite.
- ADR-002: Failure Resolution Agent replaces Conflict Resolution Agent.
- ADR-003: Attempt Log design — append-only JSONL, runner-owned, inside Worktree.
- ADR-004: Recovery protocol — structured Packet/Artifact contract between host and AI.
- ADR-005: Human Handoff policy — security-sensitive straight to handoff, defects bypass AI.

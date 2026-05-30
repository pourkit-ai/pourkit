# Open Questions

## Active

### OQ-0003 — Runtime boundary migration timeline

When should the Effect runtime migrate from the temporary local boundary inside the async Issue Runner to the CLI application edge (`runPromiseExit`)?

Context:
DEC-0004 accepts temporary local runtime boundary. Long-term goal is CLI-edge runtime.

Suggested resolution:
Defer to post-first-slice evaluation. Create a roadmap slice for this migration once the control plane pattern is proven.

---

### OQ-0004 — Full StageFailure taxonomy expansion timing

When should the StageFailure taxonomy expand beyond the minimal set needed for first slice (RebaseConflict, PublishedHistoryRisk, RecoveryArtifactInvalid, FailureResolutionAgentFailed)?

Context:
DEC-0021 limits first slice to Base Refresh. Full taxonomy defined but not implemented.

Suggested resolution:
Expand taxonomy incrementally with each new stage that adopts Effect control plane. Second slice candidate.

---

### OQ-0007 — How does the host detect security-sensitive failures for straight-to-handoff routing?

Context:
DEC-0015 requires security-sensitive failures to bypass AI. Detection mechanism not specified.

Suggested resolution:
Either classify by StageFailure type (SafetyFailure category) or by matching failure context against security patterns. Define in PRD.

---

### OQ-0008 — Attempt Log rotation/pruning policy

Will `.pourkit/attempt-log.jsonl` grow unbounded? Should there be rotation, pruning, or a max entry count?

Context:
DEC-0018 specifies append-only JSONL. No lifecycle policy defined.

Suggested resolution:
Defer. First slice can implement without rotation; add policy if log size becomes problematic.

---

### OQ-0009 — What happens when base branch moves between Builder completion and Review/PR?

Context:
DEC-0024 addresses the future parallel queue scenario. In current sequential queue, base branch moving is rare. First slice may not need staleness detection beyond Base Refresh at resume time.

Suggested resolution:
Document as future concern. First slice assumes single sequential queue where base branch does not move mid-run.

---

## Resolved

### OQ-0001 — RecoveryArtifact JSON schema exactness

Resolved by: `prds/PRD-001-base-refresh-failure-resolution-agent/PRD.md`

Resolution:
First slice validates markdown containing one required fenced `json` block with `recoveryDecision`, `summary`, `changedFiles`, `verification`, and optional `notes`.

---

### OQ-0002 — RecoveryDecision enum values for first slice

Resolved by: `prds/PRD-001-base-refresh-failure-resolution-agent/PRD.md`

Resolution:
First slice supports `RETRY_STAGE`, `HANDOFF_TO_HUMAN`, and `FAIL_RUN`; parses but does not execute `RESUME_FROM_STAGE` and `MARK_STAGE_COMPLETE`.

---

### OQ-0005 — Failure resolution budget defaults

Resolved by: `prds/PRD-001-base-refresh-failure-resolution-agent/PRD.md`

Resolution:
Default `strategy.failureResolution.maxAttemptsPerFailure` is `3`, overrideable by `failureLimits`.

---

### OQ-0006 — FailureResolutionPacket schema

Resolved by: `prds/PRD-001-base-refresh-failure-resolution-agent/PRD.md`

Resolution:
First slice packet includes `failureType`, `stage`, `attemptNumber`, `worktreePath`, `failureSummary`, `failureDetails`, `policyLimits`, `allowedDecisions`, and `artifactPath`.

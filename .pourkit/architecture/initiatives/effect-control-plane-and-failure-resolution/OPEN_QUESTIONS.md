# Open Questions

## Active

### OQ-0001 — RecoveryArtifact JSON schema exactness

What fields, types, and required/optional structure should the RecoveryArtifact JSON block use?

Context:
DEC-0011 requires a markdown artifact with a parseable JSON block. The exact schema needs to be defined in the first PRD.

Suggested resolution:
Define minimum required fields in the first PRD: `recoveryDecision`, `summary`, `changedFiles`, and verification/context fields needed for host validation.

---

### OQ-0002 — RecoveryDecision enum values for first slice

Which RecoveryDecision enum values should be implemented in the first slice?

Context:
DEC-0013 defines `RETRY_STAGE`, `RESUME_FROM_STAGE`, `MARK_STAGE_COMPLETE`, `HANDOFF_TO_HUMAN`, and `FAIL_RUN`. First slice may not need all variants.

Suggested resolution:
Define executable first-slice subset in the PRD and leave unsupported variants parsed or deferred explicitly.

---

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

### OQ-0005 — Failure resolution budget defaults

What default should `strategy.failureResolution.maxAttemptsPerFailure` use?

Context:
DEC-0009 locks a fallback max attempts value with optional per-failure overrides, but the exact default is not yet set.

Suggested resolution:
Choose a conservative default in the first PRD and allow `failureLimits` overrides for specific StageFailure types.

---

### OQ-0006 — FailureResolutionPacket schema

What fields should the structured FailureResolutionPacket include for the first slice?

Context:
DEC-0010 requires structured packet input for the Failure Resolution Agent. Exact fields need to support Base Refresh and RebaseConflict recovery.

Suggested resolution:
Define packet fields in the first PRD, including failure type, stage, attempt number, Worktree path, failure summary/details, policy limits, allowed decisions, and artifact path.

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

None yet.

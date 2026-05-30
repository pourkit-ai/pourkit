# Compressed Session

## Summary

Grill session exploring how to introduce Effect v3 into Pourkit to solve growing brittleness in Queue/Issue run failure handling. Conclusion: adopt Effect narrowly as a host-side control plane for typed failure routing and AI-assisted recovery, not as a full rewrite. First concrete slice replaces dedicated Conflict Resolution Agent with general Failure Resolution Agent under mandatory `strategy.failureResolution`, starting with Base Refresh stage.

## Architectural Shape

```
┌─────────────────────────────────────────────────┐
│                 Pourkit CLI                      │
│  ┌─────────────────────────────────────────────┐│
│  │        Effect Control Plane (host)          ││
│  │  - Typed StageFailure taxonomy              ││
│  │  - Failure policy routing                   ││
│  │  - Retry/resume/repair/handoff decisions    ││
│  │  - Attempt Log (black box recorder)         ││
│  └──────────────┬──────────────────────────────┘│
│                 │ invokes                        │
│                 ▼                                │
│  ┌──────────────────────────────┐               │
│  │ Failure Resolution Agent (AI)│               │
│  │ - Repair crew                │               │
│  │ - Reads FailureResolutionPkt │               │
│  │ - Writes RecoveryArtifact    │               │
│  │ - Recommends RecoveryDecision│               │
│  └──────────────┬───────────────┘               │
│                 │ targets                        │
│                 ▼                                │
│  ┌──────────────────────────────┐               │
│  │      Worktree (repair target)│               │
│  └──────────────────────────────┘               │
└─────────────────────────────────────────────────┘
```

Effect = factory control wiring. Failure Resolution Agent = repair crew. Attempt Log = black box recorder. Worktree = repair target. Host (Pourkit) = control plane deciding recovery; AI repairs allowed target; Worktree is repair target.

## Main Conclusions

1. Control-plane rewrite first, not full rewrite. Adapters wrap old functions; rewrite internals where typed services/testability pay off.
2. Effect adoption optimizes for workflow confidence and failure control, not stylistic consistency.
3. Recovery unit is Stage Attempt (one try at one normal pipeline stage). Recovery Attempt attaches to failed Stage Attempt.
4. Failure Resolution Agent is one general AI agent invoked by Pourkit for allowed blocking/critical typed failures. Replaces dedicated Conflict Resolution Agent.
5. `strategy.failureResolution` is mandatory; `strategy.conflictResolution` should fail config validation with clear migration message.
6. Failure Resolution Agent receives structured FailureResolutionPacket (not loose prompt) and writes structured RecoveryArtifact as markdown with required parseable JSON block under `.pourkit/.tmp/failure-resolution/attempt-{n}.md`.
7. Host decides recovery decision officially; AI recommends next RecoveryDecision.
8. Security-sensitive failures go straight to Human Handoff. Defects mostly do not go to Failure Resolution Agent.
9. Attempt Log at `.pourkit/attempt-log.jsonl` inside Worktree, runner-owned resumable metadata.
10. First slice: Base Refresh + Failure Resolution Agent. Base Refresh becomes first-class Stage Attempt. RebaseConflict handled through Failure Resolution Agent.
11. After successful Base Refresh or conflict recovery, invalidate Review/downstream and rerun Reviewer.
12. Conflict Repair Verification is AI-run inside Failure Resolution Agent recovery context, not host-run. Host validates artifact/protocol/git state.

## Important Nuance

- Effect is introduced immediately but narrowly around Base Refresh stage/recovery loop. Temporary local runtime boundary inside existing async runner is acceptable; later move `runPromiseExit` to CLI edge.
- Recovery Attempt failure is its own Recovery Attempt failure attached to original Stage Attempt — no nested recovery tree.
- Recovery budget consumed per original failure fingerprint.
- PublishedHistoryRisk and security-sensitive failures bypass AI to Human Handoff.
- Host validation after AI recovery: check artifact/protocol/git state — not run verification commands.

## Follow-up Needed

- Create PRD for first slice (Base Refresh + Failure Resolution Agent) via `Architect: next`.
- Resolve open questions about exact schema definitions for StageFailure taxonomy fields, RecoveryArtifact JSON schema, and RecoveryDecision enum values for first slice.
- Decide on exact runtime boundary migration timeline.

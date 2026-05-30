# Next

## Current State

`issues-published`

## Recommendation

Implement child Issues of PRD-037 in dependency order.

## Reason

5 child Issues published and mirrored locally. Dependency chain: I-01 → I-05, I-02 → I-04, I-03 → I-04, I-04 → I-05, I-01 → I-05. Recommended implementation order: I-01, I-02, I-03, I-04, I-05.

## Child Issues

| ID | Title | Issue | Mirror |
|----|-------|-------|--------|
| I-01 | strategy.failureResolution config schema | #75 https://github.com/pourkit-ai/pourkit/issues/75 | issues/I-01-strategy-failureResolution-config-schema.md |
| I-02 | Attempt Log module | #76 https://github.com/pourkit-ai/pourkit/issues/76 | issues/I-02-attempt-log-module.md |
| I-03 | Failure resolution domain types and validation | #77 https://github.com/pourkit-ai/pourkit/issues/77 | issues/I-03-failure-resolution-domain-types-and-validation.md |
| I-04 | Effect runtime and Base Refresh Stage Attempt | #78 https://github.com/pourkit-ai/pourkit/issues/78 | issues/I-04-effect-runtime-and-base-refresh-stage-attempt.md |
| I-05 | Failure Resolution Agent integration and downstream invalidation | #79 https://github.com/pourkit-ai/pourkit/issues/79 | issues/I-05-failure-resolution-agent-integration-and-downstream-invalidation.md |

## Dependency Graph

```
I-01 (config) ──────┐
                     ├──> I-05 (FR agent integration)
I-02 (Attempt Log) ──┐
                     ├──> I-04 (Effect runtime + Stage Attempt)
I-03 (domain types) ─┘─────> I-05
I-04 ──────────────────────> I-05
```

## Blockers

- I-04: Blocked by #76 (I-02), #77 (I-03)
- I-05: Blocked by #75 (I-01), #77 (I-03), #78 (I-04)

## Queue Command

`queue-run --prd PRD-037`

## Selected Slice

Slice 1 — Base Refresh + Failure Resolution Agent

## Local Mirror

PRD: `prds/PRD-037-base-refresh-failure-resolution-control-plane/PRD.md`
Issues: `prds/PRD-037-base-refresh-failure-resolution-control-plane/issues/`

## GitHub

Parent PRD: #74 https://github.com/pourkit-ai/pourkit/issues/74

## Resolved In PRD Scope

Resolved in PRD scope as first-slice implementation decisions:
- OQ-0001 — RecoveryArtifact JSON schema exactness
- OQ-0002 — RecoveryDecision enum values for first slice
- OQ-0005 — Failure resolution budget defaults
- OQ-0006 — FailureResolutionPacket schema

## Next Command

`queue-run --prd PRD-037` (implements child Issues in dependency order starting with I-01)

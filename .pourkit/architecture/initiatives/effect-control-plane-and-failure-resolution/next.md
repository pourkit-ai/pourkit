# Next

## Recommendation

Active PRD: `PRD-037` — Base Refresh failure resolution control plane.

## Reason

Slice 1 was stable and executable. Architect selected it as the single next PRD and mirrored the PRD body locally.

## If Ready

Selected slice: Slice 1 — Base Refresh + Failure Resolution Agent

Mirror path: `prds/PRD-037-base-refresh-failure-resolution-control-plane/PRD.md`

Issue URL: pending publication

## If Blocked

Resolved in PRD scope as first-slice implementation decisions:
- OQ-0001 — RecoveryArtifact JSON schema exactness
- OQ-0002 — RecoveryDecision enum values for first slice
- OQ-0005 — Failure resolution budget defaults
- OQ-0006 — FailureResolutionPacket schema

## Next Command

Publish `PRD-037` to GitHub with `needs-triage`, then run `Architect: breakdown`.

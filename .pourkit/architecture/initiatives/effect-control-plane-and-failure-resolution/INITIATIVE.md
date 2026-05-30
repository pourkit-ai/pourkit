# Initiative: Effect Control Plane and Failure Resolution

## Slug

`effect-control-plane-and-failure-resolution`

## North Star

Make Pourkit runs resilient by moving host-side orchestration toward an Effect-based control plane with typed failures and AI-assisted failure resolution.

## Origin

The Pourkit CLI workflow feels brittle despite extensive tests; failures in queue-run and issue-run can stop progress without enough confidence, diagnosis, or automated repair.

## Success Criteria

- Queue and Issue runs have typed, policy-routed failures instead of unstructured thrown errors.
- Recoverable blocking failures can invoke one general Failure Resolution Agent.
- Worktree resume state stays small while an append-only Attempt Log records what happened.
- Base Refresh conflicts are handled through mandatory `strategy.failureResolution`, replacing dedicated conflict resolution config.

## Boundaries

- Do not rewrite the whole CLI before proving the control-plane slice.
- Do not let AI own orchestration decisions such as merge, close, force push, or skip review.
- Do not route defects or security-sensitive failures through automatic AI repair by default.

## Related Initiatives

- TBD

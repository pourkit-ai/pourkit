# ADR-0005: Agent-Facing Verification and Label Provisioning

## Status

Accepted

## Context

Pourkit workflows require verification commands (e.g., `npm run typecheck`, `npm run test:agent`) and GitHub label provisioning during repository initialization. Before this decision, the ownership and enforcement model for both was ambiguous.

Verification commands could be either runner-enforced gates (executed and checked by the runner before allowing a PR) or agent-facing instructions (documented in run context for the agent to follow). GitHub label provisioning during `init` could be either a hard requirement (init fails without it) or a best-effort convenience.

## Decision

### Agent-Facing Verification

Verification commands SHALL be agent-facing instructions provided via run context, not runner-enforced gates. The runner does not execute, parse, or enforce verification command output.

Rationale:

1. **Agent judgment**: Agents can interpret verification failures in context — a type error in unrelated code is different from a logic error in changed code. The agent decides whether a failure is acceptable or requires a fix.

2. **Runner simplicity**: The runner's role is to produce run context and orchestrate agent roles, not interpret tool output. Keeping verification out of the runner avoids parser complexity and false positives.

3. **Iteration support**: When a reviewer finds an issue and triggers a refactor round, the agent re-runs relevant verification commands. A runner-enforced gate would conflict with this iterative workflow by blocking intermediate states.

4. **Future flexibility**: Agent-facing verification naturally supports adding or removing commands via run context without changing runner behavior.

### Best-Effort Label Provisioning

`pourkit init` SHALL attempt to provision standard GitHub triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) on the target repository, but init SHALL NOT fail if label provisioning is unavailable or unsuccessful.

Rationale:

1. **Label setup is a one-time convenience**: Labels are needed for Pourkit's issue triage workflow to function, but provisioning them during init is a setup convenience rather than a workflow-critical step. The repository owner can provision them manually or via a separate GitHub workflow.

2. **No GitHub token at init time**: The user running `pourkit init` may not have a GitHub token configured, or the token may lack repository administration permissions required to create labels. Failing init in this common case would create a poor first-run experience.

3. **Explicit error state**: Init reports label provisioning failures as warnings, not errors. The user can resolve label setup independently after init completes.

4. **Opt-out path**: Users who do not want Pourkit's triage labels can skip label provisioning without affecting other init operations.

## Consequences

- Verification commands are documented in run context for the builder agent to follow, not enforced by the runner.
- The runner does not need to understand or parse verification command output, keeping the runner simple.
- Agents have discretion over whether a verification failure requires a fix or can be accepted.
- `pourkit init` will not fail due to missing GitHub credentials or permissions.
- Label provisioning failures are surfaced as warnings, making the user aware without blocking initialization.
- Project owners who provision labels separately will see a warning but init will complete successfully.

## Alternatives Considered

- **Runner-enforced verification**: Rejected because it would add parser complexity, prevent agent discretion, and conflict with iterative review cycles where intermediate states may not pass all checks.
- **Hard label requirement**: Rejected because missing GitHub credentials or permissions at init time should not prevent repo bootstrap. Label setup is a one-time task that can be completed independently.
- **Deferred label provisioning**: Considered adding a separate `pourkit init-labels` command, but rejected as over-engineering — best-effort during init provides the right balance of convenience and robustness.

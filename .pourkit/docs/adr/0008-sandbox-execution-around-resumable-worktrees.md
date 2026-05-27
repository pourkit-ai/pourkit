# ADR-0008: Sandbox Execution Around Resumable Worktrees

## Status

Accepted

## Context

Pourkit preserves Issue Worktrees for resumable runs. Before this decision, Sandcastle execution used one-shot agent runs and host-side setup commands. That split made setup environment differ from agent execution, and it recreated sandbox/container lifecycle per stage instead of using Sandcastle's reusable sandbox model.

Sandcastle supports a split ownership model: a Worktree can be created as a first-class object, then a long-lived Sandbox can be created from that Worktree. Closing the Sandbox tears down the execution environment, while the Worktree remains available for inspection and resume.

## Decision

Pourkit SHALL treat the **Worktree** as the durable, resumable Issue state and the **Sandbox** as the disposable execution environment for a workflow run attempt.

For Sandcastle-backed execution, Pourkit SHALL create or resolve the Issue Worktree, create one Sandbox around that Worktree, run Target setup commands inside `sandbox.onSandboxReady`, and run all agent roles through `sandbox.run(...)` on that same Sandbox for the current Issue run.

Sandcastle-specific Worktree copy behavior is exposed through Pourkit sandbox configuration as `sandbox.copyToWorktree`. The execution provider must not hardcode project-specific paths such as `node_modules`.

Target setup commands may be finite setup commands or commands that start sandbox-local background services, as long as they return promptly. Readiness checks remain ordinary setup commands when needed.

Normal verification commands remain agent-facing instructions in Run Context. The runner-owned post-conflict-resolution verification path remains a known exception until runner-owned verification is moved into a sandbox command execution primitive.

## Consequences

- Builder, Reviewer, Refactor, Conflict Resolution Agent, and PR Description Agent run in the same Worktree by default.
- Setup commands run inside the Sandbox, so agents see the same installed dependencies, services, and environment that setup prepared.
- Worktree copy behavior is explicit configuration, allowing Targets and repos to decide whether paths such as `node_modules` should be copied.
- If a run fails, the Sandbox can be closed while the Worktree and Worktree Run State remain available for resume.
- On resume, Pourkit creates a fresh Sandbox around the preserved Worktree, reruns setup commands, and skips completed stages based on Worktree Run State.
- Long-running services such as a local model proxy can be started by setup commands when they background themselves and return.

## Alternatives Considered

- **Host-side setup commands**: Rejected because it prepares the host Worktree rather than the sandboxed execution environment.
- **One sandbox per agent stage**: Rejected because it loses Sandcastle's reusable-sandbox benefits and forces setup/background services to restart between stages.
- **Dedicated sandbox service config**: Deferred because setup commands that background services are sufficient for current needs.
- **Fresh Reviewer Worktree**: Rejected because Pourkit prioritizes Issue-level resumability and shared review/refactor context over isolated review Worktrees.

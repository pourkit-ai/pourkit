# ADR-0007: Structured Refactor Artifacts and Human Handoff Verdict

## Status

Accepted

## Context

PRD-036 (#1178) introduced a review/refactor loop with three verdicts (`PASS`, `FAIL`, `NEEDS_HUMAN`) and the concept of a structured Refactor Artifact. Before this decision, refactor attempts produced unstructured chat summaries that later agents could not reliably consume.

Specifically, three problems existed:

1. **Unstructured refactor output**: When a Refactor addressed Reviewer feedback, its rationale, verification results, and remaining blockers were buried in conversational text. Subsequent Reviewer iterations could not programmatically determine what had been attempted.

2. **No finding traceability**: Reviewer findings had no persistent identifiers. The same structural issue could be flagged across multiple review rounds without a way to express that a later finding superseded an earlier one, making it impossible to distinguish new findings from repeated observations.

3. **Ambiguous stop signal**: The `FAIL` verdict was used both for "the implementation is wrong, try again" and "this cannot be fixed by agents, a human must decide." Refactor had no way to distinguish between a recoverable failure and a hard stop requiring human judgment.

The team evaluated how to add structured output to the existing Refactor role, how to track findings across iterations, and how to signal a human-needed stop without overloading `FAIL`.

## Decision

### Refactor Artifact

A Refactor attempt SHALL write a structured **Refactor Artifact** — a file that records:

- Which **Reviewer** findings were addressed and how
- What verification was performed
- Any open blockers that remain

The Refactor Artifact is a **context** artifact, not a source of truth. The Reviewer SHALL NOT treat the Refactor Artifact as authoritative — it is input the Reviewer MAY read to understand what the Refactor attempted, but the Reviewer remains independent and MUST re-evaluate the implementation against the original criteria.

Refactor Artifacts follow the existing **Artifact** contract: they are files produced by an agent role and consumed by subsequent steps in the workflow.

### Finding IDs and Finding Lineage

Each **Reviewer** finding SHALL carry a unique finding ID. When a Reviewer observes that a finding from a previous iteration has been resolved and raises a related but refined finding, the new finding SHALL include a `Supersedes` link referencing the prior finding ID.

The chain of findings connected by IDs and `Supersedes` links is called the **Finding Lineage**. The Finding Lineage enables:

- Distinguishing new findings from repeated observations of the same issue
- Tracking how a finding evolves across review iterations
- Determining whether the Refactor has addressed all Reviewer concerns

A finding that repeats an earlier observation without refinement or new evidence is not a new finding — it is a repeat finding and SHOULD link to the original via `Supersedes` rather than being filed as a new, independent concern.

### NEEDS_HUMAN Verdict

The **Reviewer** SHALL support three verdicts:

| Verdict | Meaning | Action |
|---------|---------|--------|
| `PASS` | Implementation meets all criteria | Proceed to next workflow stage |
| `FAIL` | Implementation needs changes | Refactor must address findings |
| `NEEDS_HUMAN` | Agent iteration should stop | Transition issue to `ready-for-human` |

`FAIL` remains actionable by **Refactor** — the Refactor is expected to retry. `NEEDS_HUMAN` is the stop verdict: it signals that further agent iteration would not resolve the issue, and a human decision or action is required.

Rationale for not overloading `FAIL`: Overloading `FAIL` would require Refactor to guess whether to retry or escalate, which would lead to either infinite retry loops or premature escalation. A separate `NEEDS_HUMAN` verdict makes the workflow transition deterministic.

### Label Transition

When a **Reviewer** returns `NEEDS_HUMAN`, the workflow SHALL:

1. Stop the review/refactor loop
2. Remove the `ready-for-agent` label from the **Issue**
3. Add the `ready-for-human` label to the **Issue**

The `ready-for-human` label indicates that the issue requires human intervention and will not be picked up by the queue loop.

### Worktree Preservation on NEEDS_HUMAN

When an issue transitions to `ready-for-human` via `NEEDS_HUMAN`, the **Worktree** SHALL be preserved (not cleaned up). This allows a human to inspect the current state, review the Refactor Artifact, and either continue from the existing work or restart with additional context.

Resume behavior: If a human later transitions the issue back to `ready-for-agent`, the runner MAY resume from the preserved Worktree using the existing **Base Refresh** and **Worktree Run State** mechanism.

## Consequences

- Refactor output moves from unstructured chat to structured, machine-parseable **Refactor Artifacts**.
- Refactor Artifacts are consumed as context by Reviewers; Reviewers remain independent and are not bound by Refactor claims.
- **Finding IDs** and **Supersedes** links create a traceable **Finding Lineage** that prevents duplicate findings from being treated as new issues.
- `FAIL` and `NEEDS_HUMAN` are now distinct verdicts with different workflow outcomes — Refactor retries on `FAIL`, the loop stops on `NEEDS_HUMAN`.
- Issues reaching `NEEDS_HUMAN` transition to `ready-for-human` and their Worktree is preserved for human inspection.
- Existing `FAIL`-only Reviewer implementations must be updated to support the new `NEEDS_HUMAN` verdict.
- A future runner implementation should handle backward compatibility for agents on older workflow versions that only recognize `PASS`/`FAIL`, for example by mapping unrecognized verdicts like `NEEDS_HUMAN` to `FAIL`.

## Alternatives Considered

- **Status quo (unstructured chat summaries)**: Rejected because later agents could not reliably consume conversational output. Structured Artifacts provide a deterministic contract for cross-agent communication.
- **Refactor Artifact as source of truth**: Rejected because it would give the Refactor authority over what counts as resolved, undermining Reviewer independence. The Refactor Artifact is context that the Reviewer may consider but must not defer to.
- **FAIL overloaded with human-needed signal**: Rejected because it forces Refactor to guess whether to retry or escalate, leading to infinite loops or premature stops. A separate `NEEDS_HUMAN` verdict makes the decision explicit.
- **Finding IDs without Supersedes**: Rejected because without `Supersedes` links, repeated findings of the same issue would have no connection, inflating finding counts and making it harder to assess progress across iterations.
- **Worktree cleanup on NEEDS_HUMAN**: Rejected because destroying the worktree removes valuable context (partial fixes, Refactor Artifact, verification output) that a human needs to understand what happened.

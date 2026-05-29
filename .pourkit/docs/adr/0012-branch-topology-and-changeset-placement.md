# ADR-0012: Branch Topology and Changeset Placement

## Status

Accepted

## Context

Pourkit needs a uniform contributor and agent workflow for one-off work, PRD-scoped queue runs, release promotions, and urgent stable fixes. The release lanes from ADR-0011 define where publishing happens, but they do not fully define where integration work accumulates, where PRD child issues merge, or where release intent should be captured.

Without a shared branch topology, agents can target the wrong base branch, duplicate Changesets across child issues, or invent release notes during promotion. The workflow also needs to preserve CI-controlled publishing: operators create PRs and merge branches, but do not publish packages locally.

## Decision

Pourkit uses `dev` as the protected Integration Branch. One-off work merges to `dev` through PRs. PRD-scoped work creates a temporary branch named exactly `PRD-00N` from `dev`; child issue PRs merge into that PRD Branch, and the completed PRD Branch merges back to `dev`.

Pourkit keeps `next` and `main` as protected Release Lanes. Development Releases are promoted with `dev -> next` PRs. Stable Releases are promoted with `next -> main` PRs. Promotion PRs use `pourkit pr create`; merges use `pourkit pr merge`; promotion merges happen only when explicitly requested by the operator.

Changesets are placed where release intent is clearest:

- One-off `topic -> dev` PRs include a Changeset only when user-facing.
- Child issue `topic -> PRD-00N` PRs have no Changeset by default.
- Final `PRD-00N -> dev` PRs include one summarized product-increment Changeset when the PRD is user-facing.
- `dev -> next` promotions verify Changeset coverage and create catch-up Changesets only when needed.
- `next -> main` promotions do not create new Changesets by default.
- Hotfixes branch from `main` as `hotfix/<slug>`, merge to `main` with a Changeset, then reconcile forward through `main -> next` and `next -> dev` without new Changesets by default.

The `no-changeset-needed` label is required only for PRs targeting `next` or `main`. It is optional elsewhere and normally not used.

## Consequences

- Contributors and agents have one branch topology for one-offs, PRDs, promotions, and hotfixes.
- PRD queue-runs stay lightweight because child issue PRs do not duplicate release notes.
- Release intent stays close to one-off work and completed PRD product increments.
- `dev -> next` is a verification and catch-up step, not a place to invent normal release notes.
- `next -> main` remains a stable promotion step and treats missing Changesets as a process failure.
- Hotfixes can reach stable users quickly, but they require immediate reconciliation back into `next` and `dev`.
- Publishing remains CI-owned; local operators do not run Changesets publish or npm publish commands.

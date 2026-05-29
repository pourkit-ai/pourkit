# Git Workflow

## Branch Policy

Direct commits and pushes to `dev`, `next`, or `main` are not allowed. All changes must go through a topic, PRD, hotfix, or promotion branch and a pull request.

- **Protected branches**: `dev`, `next`, and `main`.
- **Integration Branch**: `dev` accumulates completed work before release promotion.
- **Release Lanes**: `next` publishes Development Releases; `main` publishes Stable Releases.
- **Temporary branches**: `PRD-00N`, `hotfix/*`, `promote/*`, and normal topic branches.

## Branch Naming

- One-off work: `feat/<name>`, `fix/<name>`, `refactor/<name>`, `docs/<name>`, `chore/<name>`.
- Agent issue work: `agent/<issue-title-slug>` or configured Pourkit branch templates.
- PRD branches: exactly `PRD-00N`.
- Hotfixes: `hotfix/<name>`.
- Promotions: `promote/<source>-to-<target>-<date>`.

## One-Off Flow

One-off work targets `dev`.

1. Branch from latest `origin/dev`.
2. Commit the scoped change.
3. Add a Changeset only when the change is user-facing.
4. Create a PR into `dev` with `pourkit pr create`.
5. Merge with `pourkit pr merge` after checks pass.

## PRD Flow

PRD work uses a temporary `PRD-00N` branch created from `dev`.

1. Create `PRD-00N` from latest `origin/dev`.
2. Run child Issue work in topic branches that target the matching `PRD-00N` branch.
3. Do not add Changesets to child Issue PRs by default.
4. If the PRD needs a prerequisite fix, merge `fix branch -> dev`, rebase `PRD-00N` onto `dev`, then continue the PRD Queue run.
5. When the PRD is complete, create a final `PRD-00N -> dev` PR.
6. Add one summarized product-increment Changeset to the final PRD PR when the PRD is user-facing.
7. Delete the `PRD-00N` branch after it merges to `dev`.

## Release Promotion Flow

Promotion PRs move already-merged work between long-lived branches. Use the `promote-release` skill for these operations.

- `dev -> next`: promote integration work to the Development Release lane. Verify Changeset coverage first and create catch-up Changesets only when needed.
- `next -> main`: promote Development Release work to the Stable Release lane. Do not create new Changesets by default; missing Changesets are a process failure to fix intentionally.

Promotion PRs use `pourkit pr create`. Merges use `pourkit pr merge` only when the operator explicitly chooses merge handling.

## Hotfix Flow

Hotfixes are only for urgent stable-user fixes.

1. Branch from latest `origin/main` as `hotfix/<slug>`.
2. Implement the smallest safe fix.
3. Include a Changeset, usually `patch`.
4. Create `hotfix/<slug> -> main` with `pourkit pr create`.
5. Merge with `pourkit pr merge` after checks pass.
6. Reconcile forward immediately with `main -> next`, then `next -> dev` promotion PRs.
7. Skip new Changesets on reconciliation PRs by default.

## Changeset Placement

A Changeset records user-facing release intent for `@pourkit/cli`. User-facing means a published CLI user can observe the change through commands, flags, outputs, prompts, errors, config behavior, generated files, package contents, workflow outcomes, or release-relevant documentation.

- One-off `topic -> dev`: add a Changeset only when user-facing.
- Child Issue `topic -> PRD-00N`: no Changeset by default.
- Final `PRD-00N -> dev`: add one summarized Changeset when user-facing.
- `dev -> next`: verify coverage and create catch-up Changesets only when needed.
- `next -> main`: do not create new Changesets by default.
- `hotfix/<slug> -> main`: include a Changeset, usually `patch`.
- Hotfix reconciliation `main -> next -> dev`: skip new Changesets by default.

Mundane `chore`, `test`, `docs`, `build`, CI, and internal-only refactor changes do not need Changesets by default. The `no-changeset-needed` label is required only for PRs targeting `next` or `main`; it is optional elsewhere and normally not used.

Do not run `npx changeset publish`, `changeset publish`, or npm publish commands locally. Release publishing is handled by CI.

## PR Body Policy

This section is the single source of truth for the canonical PR body contract. It defines the inner-body structure for GitHub PR body content and the outer-section protocol for agent-generated artifacts.

PR bodies must **never** include commit history or a list of commit messages. When providing a custom `--body`, do not include commit lists.

### Canonical Structure

Agent artifacts (PR Description Agent and finalizer output) use `## PR Title` and `## PR Body` as outer wrapper sections. Inside `## PR Body` and inside any manual or custom GitHub PR body, use the following inner sections:

```
## Summary

- Why this branch exists.
- What outcome this branch delivers.

## Changes

- Final net change 1.
- Final net change 2.
```

### Rules

- **Bullet points only** inside both inner sections. No prose paragraphs, wrapped text, or commit lists.
- **Final-state wording**: describe what the code does after this PR, not what changed during development.
- **No commit chronology**: never list commit messages or describe the development sequence.
- **Closing references**: Pourkit-managed PRs allow either no closing footer or exactly one `Closes #<current issue>` footer. Parent PRDs are workflow-closed rather than footer-closed. Issue references belong in the footer, after the inner sections.

### Good Example

```
## PR Title

feat: add user authentication

## PR Body

## Summary

- Users can now log in with email and password.
- Session tokens are stored securely.

## Changes

- Add login endpoint with password validation.
- Implement session token generation and storage.

Closes #42
```

### Bad Example: Commit Chronology, Prose, Missing Sections

```
## PR Title

implement auth

## PR Body

This PR adds user authentication. First I added the login route, then I added session management. The following commits were made:

- 1a2b3c4 add login route
- 5d6e7f8 add session management
```

## Commit Messages

- Agents must follow `.pourkit/docs/agents/commit-style.md` before creating commits.
- Non-trivial commit bodies must use markdown bullets, not wrapped prose paragraphs.
- Closing issue references belong in the footer, after the body.

## Creating A PR

Agents and humans must use `pourkit pr create`. Do not shell out to external GitHub tooling for PR creation; it bypasses branch/base validation.

```
pourkit pr create --config <path> --target <name> --title "<type>: <desc>"
pourkit pr create --config <path> --target <name> --base dev --title "fix: <desc>" --body "..."
```

Pourkit validates PR inputs, runs repo checks before PR creation, and auto-generates a default body (a simple template with the issue reference and body). For agent-driven PR creation, the finalizer produces a body following the canonical contract above. When providing a custom `--body`, follow the policy section.

## Merging A PR

Agents and humans must use `pourkit pr merge` for PR merging so Pourkit uses the same Octokit-backed provider and check-waiting behavior as the issue workflow.

```
pourkit pr merge <number>
pourkit pr merge <number> --method merge
pourkit pr merge <number> --no-wait --no-target-green
```

By default, Pourkit waits for PR checks, merges with squash, and waits for the target branch to become green after merge.

## Merge Strategy

- One-off PRs into `dev`: squash or merge commit, any preference.
- Child Issue PRs into `PRD-00N`: squash by default to keep the PRD branch readable.
- Promotion PRs: merge strategy should preserve the branch-to-branch promotion intent and avoid rewriting protected branch history.
- Hotfix PRs into `main`: use the smallest strategy that preserves the urgent fix and release intent.

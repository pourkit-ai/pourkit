# Git Workflow

## Branch policy

Direct commits and pushes to `main` or `next` are not allowed. All changes must go through a topic branch and a pull request.

- **Direct commits to `next` or `main` blocked** at commit time.
- **Topic branches** (`feat/*`, `fix/*`, etc.) must contain latest `origin/next` before commit/push.
- **Hotfix branches** (`hotfix/*`) must contain latest `origin/master` before commit/push.
- **Protected branches** (`next`, `main`) only updatable via PR merge.

## Branch naming

- Normal work: `feat/<name>`, `fix/<name>`, `refactor/<name>`, `docs/<name>`, `chore/<name>`
- Hotfixes: `hotfix/<name>`
- Agent issue work: `pourkit/{{issue.number}}/{{issue.slug}}` — always create from latest `origin/next`

## PR body policy

This section is the single source of truth for the canonical PR body contract. It defines the inner-body structure for GitHub PR body content and the outer-section protocol for agent-generated artifacts.

PR bodies must **never** include commit history or a list of commit messages. When providing a custom `--body`, do not include commit lists.

### Canonical structure

Agent artifacts (PR Description Agent and finalizer output) use `## PR Title` and `## PR Body` as outer wrapper sections. Inside `## PR Body` — and inside any manual or custom GitHub PR body — use the following inner sections:

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

### Good example

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

### Bad example (commit chronology, prose, missing sections)

```
## PR Title

implement auth

## PR Body

This PR adds user authentication. First I added the login route, then I added session management. The following commits were made:

- 1a2b3c4 add login route
- 5d6e7f8 add session management
```

## Commit messages

- Agents must follow `.pourkit/docs/agents/commit-style.md` before creating commits.
- Non-trivial commit bodies must use markdown bullets, not wrapped prose paragraphs.
- Closing issue references belong in the footer, after the body.

## Creating a PR

Agents and humans must use `pourkit pr create`. Do not shell out to external GitHub tooling for PR creation; it bypasses branch/base validation and has produced incorrect PRs targeting `master` instead of `next`.

```
pourkit pr create --config <path> --target <name> --title "<type>: <desc>"
pourkit pr create --config <path> --target <name> --base master --title "fix: <desc>" --body "..."
```

Pourkit validates PR inputs, runs repo checks before PR creation, and auto-generates a default body (a simple template with the issue reference and body). For agent-driven PR creation, the finalizer produces a body following the canonical contract above. When providing a custom `--body`, follow the policy section.

## Merging a PR

Agents and humans must use `pourkit pr merge` for PR merging so Pourkit uses the same Octokit-backed provider and check-waiting behavior as the issue workflow.

```
pourkit pr merge <number>
pourkit pr merge <number> --method merge
pourkit pr merge <number> --no-wait --no-target-green
```

By default, Pourkit waits for PR checks, merges with squash, and waits for the target branch to become green after merge.

## Merge strategy

- **Normal PRs** (topic branch -> `next`): squash or merge commit, any preference.



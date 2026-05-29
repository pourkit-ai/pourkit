---
name: promote-release
description: Promote already-merged Pourkit work between release branches with PRs, including dev -> next, next -> main, and hotfix reconciliation main -> next -> dev. Use when the user asks to promote a release, ship dev to next, ship next to main, reconcile a hotfix, or perform branch-to-branch release operations with a clean working tree.
---

# promote-release

Move already-merged work between long-lived branches. This skill creates PRs by default and merges only when the user explicitly asks.

Do not use this for current worktree diffs; use `ship-current-changes` for one-off local changes.

## Modes

- `dev -> next`: promote integration work to the Development Release lane.
- `next -> main`: promote Development Release work to the Stable Release lane.
- `main -> next -> dev`: reconcile an urgent hotfix forward after it lands on `main`.

## Workflow

### 1. Inspect State

Run the normal git inspection commands before changing anything:

```bash
git status --short --branch
git log --oneline -10
git branch --show-current
```

If the working tree is dirty, stop and ask whether the user wants `ship-current-changes` instead.

### 2. Resolve Source And Target

Infer the default from the current branch, then confirm with the user:

- On `dev`, default to `dev -> next`.
- On `next`, default to `next -> main`.
- On `main`, offer hotfix reconciliation `main -> next`, followed by `next -> dev`.

Fetch the latest remote refs and verify both source and target are the intended branches. Do not force-push, reset protected branches, or push directly to `dev`, `next`, or `main`.

### 3. Check Changeset Coverage

- For `dev -> next`, verify the promoted user-facing work has Changesets. Create catch-up Changesets only when coverage is missing and the release intent is clear.
- For `next -> main`, do not create new Changesets by default. If coverage is missing, stop and explain the process failure.
- For hotfix reconciliation `main -> next` or `next -> dev`, skip new Changesets by default because the hotfix Changeset already landed on `main`.

Use the `changeset` skill when the decision is unclear.

### 4. Create A Promotion Branch

Create a short-lived promotion branch from the target branch, then merge the source branch into it using normal git merge behavior. Resolve conflicts only when safe and obvious; otherwise stop and ask.

Example branch names:

- `promote/dev-to-next-<date>`
- `promote/next-to-main-<date>`
- `promote/main-to-next-hotfix-<date>`

### 5. Create The PR

Use `pourkit pr create`; never shell out to external GitHub tooling for PR creation.

```bash
pourkit pr create --target default --base <target-branch> --title "chore: promote <source> to <target>" --body-file <body-file>
```

Write the body to `.pourkit/.tmp/pr-body.md`, summarize the branch-to-branch promotion, then remove the temp file after PR creation.

### 6. Merge Only When Requested

Do not auto-merge promotion PRs unless the user explicitly requested merge handling. If requested, wait for checks and merge with:

```bash
pourkit pr merge <number>
```

## Safety Rules

- Create PRs by default; merge only on explicit request.
- Use `pourkit pr create` and `pourkit pr merge`.
- Never publish locally with `changeset publish`, `npx changeset publish`, or npm publish commands.
- Never direct-push to `dev`, `next`, or `main`.
- Do not invent Changesets during `next -> main` stable promotion.
- Keep hotfix reconciliation PRs free of new Changesets unless there is additional user-facing work.

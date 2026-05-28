---
name: pr-current-changes
description: Turn the current git changes into a dedicated-branch pull request, with optional direct merge. Use when the user says to create a PR from current changes, PR current changes, ship these changes, target next, or automerge local work.
---

# pr-current-changes

Create a pull request from the current worktree changes without implementing new feature work.

## Workflow

### 1. Inspect the worktree

Before changing anything, inspect:

```bash
git status --short --branch
git diff
git diff --cached
git log --oneline -10
```

Use the diff to understand the final net change and to detect secrets, generated noise, or unrelated edits. If unrelated user changes are present, do not modify or revert them; ask before including them in the PR.

### 2. Ask required questions

Ask the user:

- Which branch should the PR target? Default to the current HEAD branch; second option is to provide a custom branch.
- How should merge be handled after PR creation? Default to merge after checks are green; second option is to leave open.

Do not target `master` unless the user explicitly selects it.

### 3. Move work to a dedicated branch

If the current branch is not already a suitable topic branch, create one before committing. Use a short slug based on the diff, for example:

```bash
original_branch=$(git rev-parse --abbrev-ref HEAD)
git switch -c chore/<short-change-slug>
```

Record the original branch name (`$original_branch`) so you can return to it later.

If the current branch already has pushed commits or unrelated work, ask before reusing it. Never force-reset, discard, or overwrite user changes.

### 4. Commit current changes

Stage only the intended files. Follow `.pourkit/docs/agents/commit-style.md`:

```text
<type>: <short imperative summary>

- Explain the meaningful final change and why it matters.
- Mention tests, docs, or compatibility impact when relevant.
```

Use no body for obvious one-line changes. Do not commit secrets, local-only files, or unrelated changes.

### 5. Push the branch

Push the dedicated branch:

```bash
git push -u origin HEAD
```

### 6. Create PR title and body

Write the PR body to `.pourkit/.tmp/pr-body.md` (a repo-local temp path, gitignored by Pourkit).

Generate a relevant PR title and body from the final diff, not from commit history.

PR title format:

```text
<type>: <short description>
```

PR body format:

```md
## Summary

- Why this branch exists.
- What outcome this branch delivers.

## Changes

- Final net change 1.
- Final net change 2.
```

Use bullet points only. Do not include commit lists or development chronology.

### 7. Create the pull request

Use `pourkit pr create`; never shell out to external GitHub tooling for PR creation.

For the default (current HEAD) target:

```bash
pourkit pr create --target default --title "<type>: <desc>" --body-file <body-file>
```

For an explicitly provided custom base branch:

```bash
pourkit pr create --target default --base <branch> --title "<type>: <desc>" --body-file <body-file>
```

Capture and report the PR URL.

After the PR is created, remove `.pourkit/.tmp/pr-body.md`.

### 8. Optional merge handling

If the user chose leave open, switch back to `$original_branch` and stop.

If the user chose merge after checks are green (default), wait for checks and merge only after they pass. Use Pourkit's Octokit-backed merge command:

```bash
pourkit pr merge <number>
```

After merging, switch back to `$original_branch`.

## Safety Rules

- Inspect status, diff, and recent log before committing.
- Keep user changes intact; never revert unrelated edits.
- Create or use a dedicated topic branch before committing current changes.
- Stage only intended files.
- Use `pourkit pr create` for PR creation.
- Use `pourkit pr merge` for PR merging; do not shell out to external GitHub tooling for PR merging.
- Write PR body to `.pourkit/.tmp/` (repo-local, not `/tmp/`).
- Clean up `.pourkit/.tmp/pr-body.md` after PR creation.
- Return to `$original_branch` after merge handling.
- Ask before including ambiguous changes or targeting `master`.
- Do not amend existing commits unless the user explicitly asks.

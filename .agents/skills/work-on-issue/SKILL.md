---
name: work-on-issue
description: End-to-end workflow for implementing GitHub issues. Scaffolds branch before implementation begins, then commits, pushes, creates PR, and handles review and closure. Use when user says "work on issue", "implement issue", "pick up issue", or when starting any GitHub issue implementation.
---

# work-on-issue

End-to-end workflow for implementing a GitHub issue from start to finish.

## Workflow

### 1. Find a valid issue

Search the issue tracker for issues ready to be worked on (see `.pourkit/docs/agents/issue-tracker.md`):

Filter results:
- Exclude issues with `blocked` label
- Prefer issues with exactly one `type:*` label
- Pick the highest priority or oldest issue if multiple qualify

If no issues are found, ask the user which issue to work on or if they want to create one.

Once an issue is selected, note its number and title for later steps.

### 2. Load domain context

Read the relevant domain docs before exploring code:
- `.pourkit/CONTEXT.md` or `.pourkit/CONTEXT-MAP.md`
- `.pourkit/docs/adr/` for decisions touching the area you'll work in
- Use the glossary vocabulary from `.pourkit/CONTEXT.md`

### 3. Fetch, sync target, and create branch

```bash
git fetch origin next
git branch --force next origin/next
git checkout -b agent/<issue-title-slug> next
```

The `<issue-title-slug>` is a kebab-cased slug of the issue title (e.g. `agent/pourkit-delete-legacy-pipeline`).

### 4. Push empty branch immediately

```bash
git push -u origin HEAD
```

### 5. Implement the issue

Now begin implementation.

### 6. Commit changes

Use conventional commits with bullet-list bodies for non-trivial changes. See `.pourkit/docs/agents/commit-style.md` for the full policy.

```text
<type>: <short imperative summary>

- Explain the first meaningful change and why it matters.
- Explain the second meaningful change and its boundary.
- Mention tests, migrations, or compatibility impact when relevant.
```

### 7. Push and verify

```bash
git push
```

Verify:
- Tests pass
- Typecheck passes
- Prettier check passes

### 8. Create PR after implementation

Use `pourkit pr create` for PR submission; never shell out to external GitHub tooling for PR creation:

```bash
pourkit pr create --config <path> --target <name> --title "<type>: <desc>"
```

Follow `.pourkit/docs/agents/git-workflow.md` for the PR body contract. PR bodies must **never** include commit history or a list of commit messages.

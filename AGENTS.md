# Repository Guidance

## Agent Skills

### Local skills

All repo-specific skills live in `.agents/skills/`. Load them by name when the task matches (e.g. `work-on-issue`, `diagnose`, `security-review`, `grill-with-docs`, `tdd`).

## Codebase exploration

Use `fd` for file discovery, `rg` for text search, and direct file reads for focused context.

Follow the project's domain docs and conventions documented in `.pourkit/docs/agents/*`.

### Output style

Respond in compressed style. Drop articles (a, an, the) in prose. Use
sentence fragments over full sentences. Use short synonyms (fix not resolve,
check not investigate). Pattern: [thing] [action] [reason]. [next step].
No filler, hedging, pleasantries, trailing summaries, or restating what
the user said. One sentence if one sentence is enough.

When suggesting code changes, show only the changed lines with 3 lines of
context. Never rewrite entire files. Multiple changes in one file: show each
change separately. Never echo back unchanged code the user already has.

Code blocks, file paths, commands, error messages: always written in full.
Security warnings and destructive action confirmations: use full clarity.

## Pourkit Workflows

### Issue tracker

When using Pourkit issue workflows, see `.pourkit/docs/agents/issue-tracker.md`.

### Triage labels

Pourkit workflows use the default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `.pourkit/docs/agents/triage-labels.md`.

### Domain docs

Pourkit uses a single-context domain-doc layout. See `.pourkit/docs/agents/domain.md`.

### Issue naming

PRDs and child issues must follow the naming convention in `.pourkit/docs/agents/naming.md`.

## Git Workflow

### Git workflow

All git workflow guidance — branch naming and PR creation — lives in `.pourkit/docs/agents/git-workflow.md`.

### Commit style

Agents must write readable conventional commits with bullet-list bodies for non-trivial changes. See `.pourkit/docs/agents/commit-style.md`.

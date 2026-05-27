# Repository Guidance

## Agent Skills

### Local skills

All repo-specific skills live in `.agents/skills/`. Load them by name when the task matches (e.g. `work-on-issue`, `diagnose`, `security-review`, `grill-with-docs`, `tdd`).

## Codebase exploration

Use `fd`/`rg` or built-in file/search tools for routine lookup:
- file discovery (`fd`)
- exact strings, regex, imports, TODOs (`rg`)
- symbol names you already know
- occurrence counts
- focused reads of known files

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

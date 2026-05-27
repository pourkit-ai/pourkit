# ADR-0003: Managed Bootstrap Assets and Local Customization

## Status

Accepted

## Context

Pourkit's `init` command bootstraps a repo with agent skills, prompt templates, default configs, and documentation scaffolding. These assets fall into three ownership modes: some must be overwritable by future `update` runs, some must be preserved as project-specific customizations, and some are permanently owned by the project.

Without a clear ownership model, `update` risks destroying local modifications, and project owners cannot distinguish which files are safe to edit.

## Decision

Every asset that Pourkit creates SHALL be classified into exactly one of three ownership modes:

### Managed

Files that Pourkit fully controls. On `update`, Pourkit may overwrite these files with newer versions.

- `.pourkit/prompts/*.md` — Prompt templates that define agent behavior. Project owners may override individual prompts by converting them to copied-customizable (see below).
- `.pourkit/docs/agents/*.md` — Default agent-facing documentation stubs. Override by converting to copied-customizable.
- `.agents/skills/` contents for built-in skills — Skills shipped by Pourkit. Project owners may add custom skills alongside them.

Pourkit tracks managed files in a manifest (`.pourkit/manifest.json`) that records the origin version and hash of each managed file. On `update`, Pourkit compares manifest entries against current files and only overwrites those whose content matches the expected hash (i.e., files the project has not modified).

### Project-Owned

Files that Pourkit creates once (if absent) and never touches again.

- `.pourkit/CONTEXT.md` — Domain glossary. Once created, fully owned by the project.
- `.pourkit/CONTEXT-MAP.md` — Multi-context map. Once created, fully owned by the project.
- `docs/adr/*.md` — Architecture Decision Records. Pourkit reads them but never writes them after creation.
- `.pourkit/state.json` — Worktree Run State. Owned by the runner, not the project. Never modified by `init`/`update`.
- `.pourkit/logs/` — Runtime logs. Runner-owned, never modified by `init`/`update`.
- `.pourkit/.tmp/` — Scratch directory. Runner-owned, never modified by `init`/`update`.

### Copied-Customizable

A project owner may convert a managed file to copied-customizable by copying it out of the managed tree and placing a project-owned copy at the corresponding path in the canonical lookup order. Pourkit reads the project copy if present, falling back to the managed default.

For example, to customize the builder prompt, a project owner copies `.pourkit/prompts/builder.prompt.md` to `.pourkit/prompts/project/builder.prompt.md`. Pourkit reads `.pourkit/prompts/project/*.prompt.md` first, falling back to `.pourkit/prompts/*.prompt.md`.

### Fallback Rule

Any file that already exists on disk and is NOT tracked by the Pourkit manifest is assumed to be project-owned. Pourkit will never overwrite, delete, or modify it during `init` or `update`.

## Consequences

- **Safe updates**: Managed-file hash tracking prevents accidental overwrite of project customizations.
- **Clear boundaries**: Project owners know which files are safe to edit (project-owned, copied-customizable) and which are ephemeral (managed).
- **Auditable state**: The manifest provides a machine-readable record of Pourkit's installed assets and their versions.
- `pourkit update` behavior is not defined in this ADR beyond the future-facing rationale. The update command will be specified in a later PRD.

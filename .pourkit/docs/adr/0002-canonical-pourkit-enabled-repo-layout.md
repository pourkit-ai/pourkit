# ADR-0002: Canonical Pourkit-Enabled Repo Layout

## Status

Accepted

## Context

Pourkit-enabled repositories need a predictable filesystem layout so that agents, the Pourkit CLI, and human maintainers can find and contribute to the right locations without guessing. Repo conventions were previously split across root `CONTEXT.md`, root `docs/agents/`, root `docs/adr/`, and `.opencode/skills/` with no single record of the canonical namespace.

The `.opencode/` namespace is a legacy convention from an earlier tool. Pourkit uses `.agents/skills/` for agent skills and `.pourkit/` for its own docs, context, prompts, scratch state, and runtime metadata.

## Decision

Pourkit-enabled repositories SHALL use the following canonical layout:

```
<repo-root>/
├── .agents/
│   └── skills/              # Agent skill definitions (loaded by name at runtime)
├── .pourkit/
│   ├── docs/
│   │   ├── agents/          # Agent-facing documentation (naming, domain, ADRs, etc.)
│   │   └── adr/              # Architecture Decision Records
│   ├── CONTEXT.md            # Primary domain glossary and context
│   ├── CONTEXT-MAP.md        # Multi-context map (present only in multi-context repos)
│   ├── prompts/              # Agent prompt templates
│   ├── logs/                 # Runtime logs (runner-owned, not agent-editable)
│   ├── .tmp/                 # Scratch/temp directory for run artifacts
│   └── state.json            # Worktree Run State (runner-owned, not agent-editable)
├── docs/
│   └── agents/               # Optional symlink or forwarding docs for IDE convenience
├── CONTEXT.md                # Optional symlink or root forwarding doc
├── CONTEXT-MAP.md            # Optional symlink or root forwarding doc
└── ...                       # Project source code
```

Key ownership rules:

- **`.agents/skills/`** — Mixed-ownership directory. Built-in skill files shipped by Pourkit are managed (tracked in the manifest and overwritable on `update`). Custom skill files added by the project are project-owned (never overwritten).
- **`.pourkit/`** — Mixed-ownership namespace. Managed files (`prompts/*.md`, `docs/agents/*.md`) are tracked in the manifest and may be updated. Project-owned files (`CONTEXT.md`, `CONTEXT-MAP.md`) are created once and never overwritten. Runner-owned files (`state.json`, `logs/`, `.tmp/`) are never modified by `init`/`update`.
- **`docs/adr/`** — Project-owned. ADRs are durable records written by agents and humans. Pourkit reads but does not overwrite them.
- **`CONTEXT.md` / `CONTEXT-MAP.md` (root)** — Optional root forwarding docs for IDE compatibility. The canonical copies live under `.pourkit/`.

Pourkit dogfoods this layout — the Pourkit repo itself follows the same convention (`.pourkit/prompts/`, `.pourkit/.tmp/`, etc.).

## Consequences

- Agents can discover domain context, ADRs, prompts, and skills at predictable paths.
- The Pourkit CLI knows exactly which paths to create on `init` and which to preserve on `update`.
- Root-level forwarding docs reduce friction for tools that expect `CONTEXT.md` at the root.
- `.opencode/skills/` is not part of the canonical layout; it is a legacy convention that may coexist during migration.

## Alternatives Considered

- **Keep `.opencode/` as canonical**: Rejected because `.opencode` is a separate-tool namespace. Pourkit should not claim ownership of another tool's directory.
- **Flat layout under root**: Rejected because mixing Pourkit metadata with project source creates noise and collision risk.
- **No forwarding docs at root**: Rejected because some editors and CI tools hardcode `CONTEXT.md` at the repo root.

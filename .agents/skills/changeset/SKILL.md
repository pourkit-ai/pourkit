---
name: changeset
description: Decide whether a Changeset is needed, choose patch/minor/major version intent, and author or review .changeset/*.md files for Pourkit branch flows. Use when the user asks about Changesets, release notes, version bumps, user-facing changes, no-changeset-needed, or before PRs into dev, next, main, PRD branches, or hotfix branches.
---

# changeset

Decide release intent and manage `.changeset/*.md` files. Do not publish locally.

## Decision Rules

### User-Facing Changes

Add a Changeset when the final PR changes something users of the published CLI can observe:

- CLI commands, flags, arguments, outputs, prompts, errors, exit behavior, or generated files.
- Configuration shape, defaults, validation, target behavior, or workflow outcomes.
- Public package contents, package metadata, install behavior, or binary behavior.
- Documentation that is part of the release story for CLI users.

Skip a Changeset by default for mundane `chore`, `test`, `docs`, `build`, CI, and internal-only refactor changes.

### Branch-Specific Placement

- One-off `topic -> dev`: add a Changeset only when user-facing.
- Child issue `topic -> PRD-00N`: no Changeset by default.
- Final `PRD-00N -> dev`: add one summarized product-increment Changeset when the PRD is user-facing.
- `dev -> next`: verify coverage; create catch-up Changesets only when needed.
- `next -> main`: do not create new Changesets by default. Missing Changesets are a process failure to fix intentionally.
- `hotfix/<slug> -> main`: include a Changeset, usually `patch`.
- Hotfix reconciliation `main -> next` and `next -> dev`: skip new Changesets by default.

The `no-changeset-needed` label is required only for PRs targeting `next` or `main` that intentionally have no Changeset. It is optional elsewhere and normally not used.

## Version Intent

- `patch`: user-facing bug fix, wording fix, resilience improvement, or compatible behavior correction.
- `minor`: new command, flag, workflow, capability, or compatible user-facing behavior.
- `major`: breaking CLI behavior, breaking config behavior, removed feature, or migration-required change.

When unsure between `patch` and `minor`, choose the smallest version intent that accurately describes what stable users receive.

## Authoring Workflow

1. Inspect the final diff, target branch, and PR purpose.
2. Decide whether the change is user-facing.
3. If no Changeset is needed, document why in the PR summary or ensure `no-changeset-needed` is applied when targeting `next` or `main`.
4. If a Changeset is needed, create a single focused file under `.changeset/`.
5. Keep the summary user-facing and final-state oriented.
6. Review that the package name and bump type are correct.

Use this package frontmatter for public CLI changes:

```md
---
"@pourkit/cli": patch
---

Describe the user-facing behavior that stable users will receive.
```

Do not run `npx changeset publish`, `npm run changeset:publish`, or `changeset publish` from a developer machine. Publishing is handled by CI on release lanes.

## Review Checklist

- The file lives under `.changeset/` and has a unique descriptive name.
- The package is `@pourkit/cli` unless a future public package exists.
- The bump type matches the user impact.
- The prose describes the released behavior, not implementation chronology.
- Internal-only work does not invent release notes.
- PRs targeting `next` or `main` have either a Changeset or `no-changeset-needed`.

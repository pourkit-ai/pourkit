# Handoff: Vera Integration Design

## Summary

Grill session that pressure-tested a design for integrating Vera semantic search into Pourkit's init, runtime, and sandbox image workflows. All decisions are agreed; no unresolved questions remain. Next step is to create a PRD from this document.

## Domain Language (to add to `.pourkit/CONTEXT.md`)

- **Vera Index**: A repo-level local semantic search index stored in `.vera/`, shared across Pourkit Worktrees by mount/link and refreshed from the most recently updated Worktree after edit-capable stages. *Avoid*: Worktree index, agent artifact, run state.
- **Vera Bootstrap**: The explicit `pourkit init --vera` setup path that installs Vera tooling for the operator context and creates the first repo-level Vera Index when `.vera/` is absent. *Avoid*: Runtime setup, per-run indexing.
- **Vera Integration**: Runtime wiring that makes an existing repo-level Vera Index available to agent Worktrees and refreshes it after edit-capable stages. *Avoid*: Vera bootstrap, automatic indexing.

## ADR to Create

`ADR-0008: Shared Repo-Level Vera Index for Agent Worktrees`

Core decision: one shared `.vera/` index mounted/linked into Worktrees; never create per-Worktree indexes; update from the current edited Worktree after edit-capable stages; protect updates with a best-effort lock; concurrent multi-Worktree semantics out of scope.

## Agreed Decisions

### Config & Scope

| Decision | Value |
|----------|-------|
| Config location | Repo-level, not under Target or Strategy |
| Config shape | `{ vera: { enabled: true } }` (root only) |
| Omitted when disabled | Yes, do not write `vera` block unless integration is enabled |
| `updateAfterAgentEdits` | Implied by `enabled: true`; do not add separate config flag yet |
| Unknown Vera keys | Rejected by strict Zod validation (ADR-0006) |
| Config validation | Boundary-only, colocated in `pourkit/shared/config.ts` |

### Bootstrap (`pourkit init`)

| Decision | Value |
|----------|-------|
| Entry point | `pourkit init --vera` (CLI flag) and interactive prompt: `[y/N]` |
| Install method | Separate steps: `npx -y @vera-ai/cli install`, `vera setup`, `vera index .` |
| Existing `.vera/` | Skip install/index; still write `vera.enabled: true` |
| `.gitignore` | Ensure `.vera/` is ignored whenever integration is enabled (write to init-managed ignore block) |
| Failure when explicit | Fail the whole `init` if `--vera` was passed or interactive user chose Vera and bootstrap fails |
| Failure when implicit | If `.vera/` missing and no explicit Vera choice, continue without Vera |
| Docker image | Vera CLI install is handled by managed sandbox template/update flow, not by `init --vera` |

### Runtime Integration

| Decision | Value |
|----------|-------|
| `.vera/` present + `enabled: true` | Mount/link and use |
| `.vera/` missing + `enabled: true` | Warn once per run, skip all Vera work |
| `vera` binary missing + `enabled: true` | Warn once per run, skip |
| Auto-detect without config | No; require explicit config opt-in |
| Index reuse | One repo-level index shared across Worktrees |
| Index reflects | The most recently updated Worktree, not all branches concurrently |

### Worktree Bridge

| Decision | Value |
|----------|-------|
| Dockerized Worktrees | Mount repo `.vera/` via Sandcastle `mounts` (hostPath, sandboxPath, `readonly: false`) |
| Host/local Worktrees | Create temporary `.vera` symlink if missing |
| Bridge lifecycle | Created before agent stage, removed after stage/run if created by Pourkit |
| Pre-existing `.vera` in Worktree | Never modify or remove if it pre-existed |
| Available to | All agent roles (Builder, Reviewer, Refactor, Conflict Resolution, Finalizer) |

### Post-Stage Updates (`vera update .`)

| Decision | Value |
|----------|-------|
| After Builder | Yes |
| After Refactor | Yes |
| After Conflict Resolution Agent | Yes |
| After runner verification (post-CR) | Yes, only when immediately following edit-capable recovery |
| After ordinary Reviewer | No |
| After Finalizer | No |
| After standalone verification | No |
| Update behavior | Best-effort, non-blocking, warning-only on failure |
| Lock location | `.vera/.pourkit-update.lock` |
| Stale lock cleanup | Remove if older than 30 minutes |
| Lock on hold | Warn and skip |
| Update from | Inside the changed Worktree (using shared index via mount/symlink) |

## Preflight

| Decision | Value |
|----------|-------|
| Occurrence | Once per run |
| Checks | `vera.enabled: true`, `.vera/` exists, `vera` executable available |
| Failure | Warn and skip all Vera work for that run |

## Files to Change

| File | Purpose |
|------|---------|
| `pourkit/commands/init.ts` | Add Vera bootstrap as init operation kind; prompt; plan/apply; `.gitignore` entry |
| `pourkit/cli.ts` | Add `--vera` / `--no-vera` flags |
| `pourkit/shared/config.ts` | Add optional `vera.enabled` to config schema, domain type, resolved config |
| `pourkit/execution/sandbox-options.ts` | Append `.vera` mount when enabled and present |
| `pourkit/execution/execution-provider.ts` | Add `updateVeraIndex()` helper (lock, symlink, command, cleanup) |
| `pourkit/commands/issue-run.ts` | Call Vera update after edit-capable stages and post-CR verification |
| `.sandcastle/Dockerfile` | Install Vera CLI in managed sandbox template |
| `pourkit/commands/init.test.ts` | Tests for init planning, dry-run, `.vera` skip, command mocks, `.gitignore` |
| `pourkit/commands/config.test.ts` | Tests for `vera` config parsing/defaults/rejection |
| `pourkit/commands/sandbox-options.test.ts` | Tests for `.vera` mount injection |
| `pourkit/commands/issue-run.test.ts` | Tests for `vera update` after edit stages, not after non-edit stages, lock behavior |

## Docs to Create/Update

| Document | Action |
|----------|--------|
| `.pourkit/CONTEXT.md` | Add Vera Index, Vera Bootstrap, Vera Integration glossary terms |
| `.pourkit/docs/adr/0008-shared-repo-level-vera-index.md` | Create ADR |
| `.pourkit/handoffs/vera-integration-design.md` | This file |

## Suggested Skills for Next Session

- `code-review` — after implementing, run review cycle
- `to-prd` — consume this handoff to produce a PRD before implementation

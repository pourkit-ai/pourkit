# Serena + Pourkit Integration

Entry point for this handoff directory. Read this first when starting a new
session or receiving a handoff related to Serena integration.

---

## Orientation

Serena is an external MCP tool providing LSP-backed code understanding
(symbol search, declaration lookup, reference tracking, diagnostics).
Pourkit integrates Serena as a **long-lived Docker sidecar container**
to give Builder/Refactor agents baseline code intelligence during
Issue runs.

---

## File Map

| File | Purpose | When to read |
|------|---------|-------------|
| `README.md` | This file. Entry point, last discussion, update protocol. | **First.** |
| `glossary.md` | Domain terms for Serena integration. | After README, before any other doc. |
| `integration-plan-and-tradeoffs.md` | Full architecture plan: Batch Baseline model, diagrams, lifecycle flows, config surface, validation report, rejected alternatives, unresolved questions, implementation priority. | Primary design doc. Read after glossary. |
| `serena-documentation-reference.md` | Extracted facts from Serena's published docs (Docker, MCP, contexts, modes, config, tools). Reference only, not design decisions. | As needed for factual lookups. |

---

## Last Discussion (30 May 2026)

Session covered:

- **Rejected** Worktree remount + exclusive lease model (Option A).
- **Adopted** Batch Baseline model: Serena sidecar indexes a runner-owned
  Baseline Worktree checked out at target `baseBranch`. Parallel Issue
  Worktrees share same baseline read-only. No per-Worktree remount.
- **Added** validation report in
  `.pourkit/handoffs/serena/integration-plan-and-tradeoffs.md` for Docker HTTP
  MCP startup, mounted repo indexing, incremental update, Sandcastle
  networking, and multi-client assumptions.
- **Observed** live Docker validation is blocked on this host because the
  `docker` CLI is unavailable.
- **Rule**: Single index, created once, never re-indexed per run.
  Baseline Refresh uses `git fetch + checkout` and relies on Serena
  incremental file-watch / LSP for updates.
- **Rule**: Serena is stale during batch — agents see baseline commit
  intelligence only. OpenCode file tools are source of truth for
  in-flight Worktree edits.
- **Rule**: Serena baseline is set at command start, not persistent
  across commands. Between commands, Serena may be stale. Next
  Serena-enabled command refreshes before use.
- Container and CLI management: `pourkit serena init/start/stop/status
  /reindex/refresh` commands.
- `--network host` recommended for simplest Sandbox → Serena networking.
- `serena.required: false` by default (opportunistic, warn on failure).
- Host OpenCode may compete with Pourkit for same Serena + Baseline
  Worktree — unresolved question #9 in integration plan.

Key reference: `.pourkit/handoffs/serena/integration-plan-and-tradeoffs.md`
sections Architecture Decision, Batch Baseline Lifecycle, Validation Report,
and Resolved Questions.

---

## Recommended Reading Order

For a new session continuing Serena work:

1. `glossary.md` — learn the terms
2. `README.md` (this file) — last discussion context
3. `integration-plan-and-tradeoffs.md`
   - Architecture Decision (diagram + core idea)
   - Batch Baseline Lifecycle
   - Tradeoff Analysis (why not other options)
   - Implementation Priority (what to build next)
4. `serena-documentation-reference.md` — as needed

---

## How to Update These Docs

If this session produces new decisions, implementation progress, or
revisions:

### Glossary

- Add new terms to `glossary.md` when a concept becomes durable.
- Terms are alphabetical. Each term gets its own `##` section.
- Use `(archived concept)` suffix for rejected proposals that may appear
  in handoff history.

### README

- Update **Last Discussion** section at end of session with:
  - date
  - key decisions made
  - which files changed
  - what next session should focus on
- Add any new recommended readings.
- Move old Last Discussion entries to a **Previous Sessions** section
  if they accumulate beyond 3 entries.

### Integration Plan

- Move resolved questions from Unresolved → Resolved tables.
- Update Implementation Priority when phases are complete.
- Update Files Likely To Change when new files are added or old ones
  become irrelevant.
- If a rejected alternative is later reconsidered, do not delete
  rejection rationale — add new consideration section linking to it.

### When Starting a New Handoff

Before handing off to another agent or ending a session:

1. Update **Last Discussion** in README with session state.
2. Ensure glossary reflects any new terms coind during session.
3. Ensure integration plan resolved/unresolved tables reflect
   current state.
4. Commit docs as part of the branch if session made code changes.

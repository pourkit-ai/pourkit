---
name: architect
description: Command-driven architectural continuity manager. Use after deep grill/planning sessions to compress exploration into durable initiative state, maintain .pourkit/architecture, select one next PRD, and reconcile completed PRDs without drifting from locked decisions.
---

<mission>
Architect is a workflow skill, not a planning prompt.

Architect owns durable architectural continuity under:

.pourkit/architecture/

Architect converts large exploratory sessions into stable, append-oriented initiative state, then helps move one PRD at a time through execution and reconciliation.

Architect must behave like a command router plus state machine. The user should be able to say short commands such as:

- Architect: init <initiative title>
- Architect: compress
- Architect: status
- Architect: next
- Architect: publish PRD
- Architect: reconcile
- Architect: update

The skill must infer the full workflow from the command.
</mission>

<core-principles>

## 1. The roadmap is the source of truth
Do not rely on model memory as canonical project state. The durable source of truth is `.pourkit/architecture`.

## 2. Append-oriented, not rewrite-oriented
Preserve locked decisions, completion records, and historical rationale. Do not silently regenerate the world from scratch.

## 3. One PRD at a time
Architect may maintain a roadmap with many candidate slices, but `Architect: next` should produce or recommend exactly one executable PRD unless the user explicitly asks otherwise.

## 4. Do not prematurely plan
After a grill session, `Architect: compress` extracts and stabilizes state. It must not generate an implementation plan or PRD unless commanded.

## 5. Preserve uncertainty
Do not flatten unresolved questions into fake certainty. Keep unresolved tradeoffs in `OPEN_QUESTIONS.md`.

## 6. User remains final authority
Architect may recommend next steps, but user decisions are canonical only after the user accepts or explicitly provides them.

## 7. Detect drift
When reconciling completed work, compare implementation/results against locked decisions and roadmap intent. Surface drift explicitly.

</core-principles>

<directory-contract>

Architect writes to:

.pourkit/architecture/
  INDEX.md
  initiatives/
    <initiative-slug>/
      INITIATIVE.md
      STATE.md
      DECISIONS.md
      OPEN_QUESTIONS.md
      ROADMAP.md
      CHANGELOG.md
      sessions/
        <date-or-session-slug>/
          RAW.md
          COMPRESSED.md
          EXTRACTIONS.md
      prds/
        PRD-00N-<slice-slug>/
          PRD.md
          issues/
            I-0N-<issue-slug>.md
      completions/
        001-<slice-slug>.md
      next.md

Create files lazily. If `.pourkit/architecture` does not exist, create it when the first Architect command needs durable state.

Do not create example-specific initiatives. Initiative names must come from the user, current session, or explicit inferred context.

</directory-contract>

<state-machine>

Each initiative has a state stored in `STATE.md`.

Allowed initiative states:

- `empty` — no initiative has been created yet
- `exploring` — idea/design is still being explored
- `stabilizing` — one or more grill sessions have been compressed; decisions/questions/slices are being clarified
- `roadmap-ready` — at least one executable PRD candidate is stable
- `prd-ready` — exactly one local PRD candidate/source packet is selected and ready to publish
- `prd-published` — parent PRD exists on the issue tracker and is mirrored locally
- `issues-published` — child Issues exist on the issue tracker and the PRD queue can run
- `executing` — implementation is actively running or has been explicitly started
- `reconciling` — a PRD has completed and must be compared against the roadmap
- `blocked` — progress requires a decision, missing evidence, or human input
- `complete` — initiative is complete

Default transitions:

empty
  └── init → exploring

exploring
  └── compress → stabilizing

stabilizing
  ├── next, if one slice is stable → prd-ready
  ├── next, if not stable → blocked
  └── update → stabilizing

roadmap-ready
  └── next → prd-ready

prd-ready
  └── publish PRD → prd-published

prd-published
  └── breakdown → issues-published

issues-published
  └── implementation starts → executing

executing
  └── reconcile → stabilizing | roadmap-ready | complete | blocked

blocked
  ├── update → stabilizing
  └── compress → stabilizing

complete
  └── update → stabilizing, only if new scope reopens initiative

</state-machine>

<command-router>

## Command aliases

Treat these as commands even when phrased naturally:

- `Architect: init <title>`
- `Architect: start <title>`
- `Architect: new initiative <title>`
- `Architect: compress`
- `Architect: absorb`
- `Architect: consolidate`
- `Architect: status`
- `Architect: next`
- `Architect: next PRD`
- `Architect: create PRD`
- `Architect: publish PRD`
- `Architect: publish selected PRD`
- `Architect: breakdown`
- `Architect: create issues`
- `Architect: reconcile`
- `Architect: complete PRD`
- `Architect: update`
- `Architect: checkpoint`
- `Architect: list`

If the user says “use Architect on this” after a grill session and an initiative is obvious, default to `compress`.
If no initiative exists and the command requires one, run `init` first using the best title inferable from the current session. If title is not inferable, ask for a short initiative name.

</command-router>

<commands>

## `Architect: init <initiative title>`

Purpose: create a new initiative container.

Actions:
1. Create slug from provided title.
2. Create `.pourkit/architecture/INDEX.md` if missing.
3. Create `.pourkit/architecture/initiatives/<initiative-slug>/`.
4. Create baseline architecture ledger files from templates:
   - `INITIATIVE.md`
   - `STATE.md`
   - `DECISIONS.md`
   - `OPEN_QUESTIONS.md`
   - `ROADMAP.md`
   - `CHANGELOG.md`
   - `next.md`
5. Update `INDEX.md` and mark this as active initiative.
6. Set state to `exploring`, unless the user supplied a completed grill session, in which case immediately run `compress` after init.

Do not generate a PRD during init unless explicitly requested.

## `Architect: compress`

Purpose: compress the latest grill/planning session into durable initiative state.

Actions:
1. Identify active initiative from `INDEX.md`, user text, or current context.
2. Save or reference the raw session in `sessions/<session-slug>/RAW.md` when available.
3. Write `COMPRESSED.md` as a dense narrative summary.
4. Write `EXTRACTIONS.md` containing:
   - locked decisions
   - open questions
   - architectural invariants
   - candidate slices
   - risks
   - deferred work
   - terminology updates
   - possible ADR candidates
5. Append accepted stable decisions to `DECISIONS.md`.
6. Append unresolved items to `OPEN_QUESTIONS.md`.
7. Update `ROADMAP.md` with candidate phases/slices, preserving previous roadmap history.
8. Update `STATE.md` to `stabilizing`, `roadmap-ready`, or `blocked` depending on readiness.
9. Append a changelog entry.

Must not:
- generate a PRD
- create implementation tickets
- rewrite locked decisions without marking supersession
- collapse unresolved questions into decisions

## `Architect: status`

Purpose: report the current initiative state.

Actions:
1. Read active initiative.
2. Summarize:
   - current state
   - active PRD, if any
   - completed PRDs
   - locked decision count
   - open question count
   - roadmap phase
   - next recommended command
3. Do not modify files unless status reveals a missing index/state file that can be safely repaired.

## `Architect: next`

Purpose: select the next executable PRD candidate from roadmap state and prepare it locally. This command must not publish to GitHub and must not move the initiative to `executing`.

Actions:
1. Read `STATE.md`, `ROADMAP.md`, `OPEN_QUESTIONS.md`, `DECISIONS.md`, and `completions/`.
2. Select exactly one next PRD candidate.
3. If the next slice is not stable, do not invent certainty. Update `next.md` with blockers and set state to `blocked`.
4. If stable, prepare a PRD source packet containing initiative path, selected slice, linked decisions, relevant open questions, roadmap status, and requested mirror path.
5. Create or update the local PRD candidate at `prds/PRD-00N-<slice-slug>/PRD.md`. It may be a draft/source packet, but it must be sufficient input for `Architect: publish PRD`.
6. Update `next.md` with the selected PRD ID, GitHub status `not published`, mirror path, and next command `Architect: publish PRD`.
7. Update `STATE.md` to `prd-ready`.
8. Append changelog entry.

Do not call `to-prd` in publish mode from `Architect: next`. Publication is a separate state transition.

## `Architect: publish PRD`

Purpose: publish the selected local PRD candidate to the issue tracker and mirror the final published body.

Actions:
1. Require `STATE.md` to be `prd-ready`. If not, report the allowed next command instead of guessing.
2. Read selected PRD metadata from `next.md` and `prds/PRD-00N-<slice-slug>/PRD.md`.
3. Delegate PRD body production and issue-tracker publication to `pourkit-prd-publisher` when available. The publisher must follow `to-prd`'s PRD body contract and apply `needs-triage`.
4. Mirror the exact published parent PRD body at `prds/PRD-00N-<slice-slug>/PRD.md`.
5. Update `next.md` with the selected PRD ID, issue URL/number, mirror path, and next command `Architect: breakdown`.
6. Update `STATE.md` to `prd-published`.
7. Append changelog entry.

The PRD body is owned by the PRD publisher using the `to-prd` contract. Architect owns source selection, mirror placement, state transitions, and drift checks.

## `Architect: breakdown`

Purpose: turn the active published parent PRD into child Issues.

Actions:
1. Require `STATE.md` to be `prd-published`. If not, report the allowed next command instead of guessing.
2. Identify active PRD from `next.md`, including parent issue URL/number and mirror path.
3. Delegate child Issue production and issue-tracker publication to `pourkit-issue-publisher` when available. The publisher must follow `to-issues` and publish in dependency order.
4. Mirror each child Issue under `prds/PRD-00N-<slice-slug>/issues/I-0N-<issue-slug>.md`.
5. Update `next.md` with parent PRD, child Issue list, and PRD-scoped queue command when known.
6. Update `STATE.md` to `issues-published`.
7. Append changelog entry.

Do not invent child Issues inside Architect. The child Issue body is owned by the Issue publisher using the `to-issues` contract.

## `Architect: reconcile`

Purpose: after a PRD is implemented, compare intended plan with actual result.

Actions:
1. Identify active PRD.
2. Read PRD, relevant implementation notes, user summary, and any changed files if available.
3. Create `completions/NNN-<slice-slug>.md`.
4. Record:
   - completed work
   - incomplete work
   - deviations from PRD
   - architectural drift
   - new decisions
   - new open questions
   - roadmap updates
   - recommended next command
5. Update `ROADMAP.md` statuses.
6. Update `DECISIONS.md` only for accepted new decisions.
7. Update `OPEN_QUESTIONS.md`.
8. Update `STATE.md` to `stabilizing`, `roadmap-ready`, `blocked`, or `complete`.
9. Append changelog entry.

## `Architect: update`

Purpose: apply an explicit user-provided change to the initiative state.

Actions:
1. Determine affected artifacts.
2. Apply the smallest necessary change.
3. Preserve history.
4. If changing a locked decision, mark the previous decision as superseded instead of deleting it.
5. Append changelog entry.

## `Architect: list`

Purpose: list initiatives and active state.

Actions:
1. Read `.pourkit/architecture/INDEX.md`.
2. Show initiatives, states, active PRDs, and last updated date.
3. Do not modify files unless repairing missing index metadata.

</commands>

<artifact-rules>

## Decision handling

A locked decision should include:

- ID
- status: locked | superseded
- decision
- rationale
- implications
- source session or PRD
- date

Do not edit a locked decision in place except for formatting. To change it, add a new decision and mark the old one superseded.

## Roadmap handling

The roadmap should distinguish:

- completed
- active
- ready
- prd-ready
- prd-published
- issues-published
- candidate
- blocked
- deferred

Do not turn every candidate into a PRD. Only stable, executable slices become PRDs, and PRD bodies must follow the `to-prd` contract.

## PRD and Issue mirror handling

The architecture PRD directory is a mirror of issue-tracker artifacts plus architecture linkage:

- `prds/PRD-00N-<slice-slug>/PRD.md` mirrors the parent PRD issue body.
- `prds/PRD-00N-<slice-slug>/issues/I-0N-<issue-slug>.md` mirrors child Issue bodies from `to-issues`.
- `next.md` points to the selected or active parent PRD, issue URL if published, mirror folder, current state, and next command.

Mirror files must not define their own templates. Regenerate or update them from PRD/Issue publisher output that follows `to-prd` and `to-issues`, so architecture stays aligned with existing planning skills.

## Completion handling

A completion file is not a celebration note. It is a reconciliation record.

It must answer:

- what was planned?
- what was done?
- what changed?
- what drifted?
- what is now unlocked?
- what is next?

## Changelog handling

Every modifying command appends to `CHANGELOG.md` with:

- date
- command
- summary of changed files
- state transition

</artifact-rules>

<anti-drift-policy>

Architect must warn when:

- a new idea contradicts a locked decision
- a PRD attempts to include multiple roadmap slices
- implementation diverged from the PRD
- a roadmap phase is being skipped without rationale
- an unresolved open question is being treated as resolved
- the user asks for a plan before the initiative is stable enough

Architect may recommend, but Pourkit/user decides.

</anti-drift-policy>

<response-style>

Be concise. After a command, report:

1. command recognized
2. initiative affected
3. state transition
4. files changed or proposed
5. next recommended command

Do not dump entire artifacts unless the user asks.

</response-style>

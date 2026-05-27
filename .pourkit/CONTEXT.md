# Pourkit

Pourkit is an AI-driven GitHub issue-to-PR workflow. It automates the lifecycle of picking up an issue, implementing it in a worktree, running verification, creating a PR, and handling review iterations. The domain language here describes the agent workflow rather than implementation structure.

## Language

**Issue**:
A GitHub issue that represents a unit of work to be implemented by an agent.
_Avoid_: Ticket, task, story

**Target**:
A named configuration entrypoint that defines lane metadata such as base branch, branch template, setup commands, and exactly one Strategy for a workflow run. The base branch (`baseBranch`) names the remote-backed lane and PR base — it does not name a local branch that Pourkit owns or force-updates.
_Avoid_: Environment, profile

**Strategy**:
A first-class execution contract under a Target that owns executable workflow behavior, including builder, review, verification, refactor, and finalize stages.
_Avoid_: Global execution config, target-level execution fields

**Worktree**:
A Git worktree where agent roles perform Issue work, isolated from the main checkout. All agent roles for a workflow run use the same Worktree by default so builder, review, refactor, conflict resolution, and finalizer context remain resumable together.
_Avoid_: Branch checkout, sandbox

**Sandbox**:
The disposable execution environment attached to a Worktree for setup commands and agent runs. A Sandbox may host multiple agent roles in sequence during a workflow run; the Worktree remains the durable resumable unit when the Sandbox is closed.
_Avoid_: Worktree, branch checkout

**Builder**:
The agent role responsible for implementing an issue in a worktree and producing artifacts (code changes, run context).
_Avoid_: legacy implementation-role wording, coder

**Advisory Analyzer**:
A hidden, non-authoritative subagent used by Builder and Refactor to catch concrete scoped defects before completion. It produces advisory output only, writes no artifacts, and never decides issue completion.
_Avoid_: Preflight Reviewer, shadow Reviewer

**Reviewer**:
The agent role responsible for evaluating the builder's output against criteria (correctness, scope, tests, quality) and producing a review artifact.
_Avoid_: Code review, audit

**Refactor**:
The agent role responsible for addressing reviewer feedback by making targeted changes to the builder's work.
_Avoid_: Fix, patch

**Run Context**:
A shared markdown file (`.pourkit/.tmp/run-context.md`) that captures issue details, branch info, verification results, and review outputs for a workflow run.
_Avoid_: State file, metadata

**Worktree Run State**:
Runner-owned local metadata stored inside a Worktree (`.pourkit/state.json`) for resume decisions. Unlike **Run Context**, this is not agent-editable prompt context — it is consumed by the runner to determine whether a failed run can be resumed.
_Avoid_: State file, agent context

**Artifact**:
A file produced by an agent role (e.g., review output, PR description) that is read by subsequent steps in the workflow.
_Avoid_: Output, result

**Queue**:
The set of issues in `ready-for-agent` state that the `queue-run` command processes sequentially. In normal mode, the Queue may include any runnable ready-for-agent issue. In PRD-scoped mode (`queue-run --prd PRD-00N`), the Queue is limited to child issues whose parent is the selected PRD.
_Avoid_: Backlog, pipeline

**Queue Loop**:
The repeated processing mode in which `queue-run` drains runnable Issues from the **Queue** sequentially until no runnable Issues remain. Before each selection round, the Queue Loop reconciles blocked Issues; after a completed Issue is closed, it reconciles blocked Issues again.
_Avoid_: Parallel loop, batch mode

**PR Description Agent**:
The agent role responsible for generating a PR body from the run context and review artifacts.
_Avoid_: Summary generator

**Runtime Boundary Validation**:
Validation of unknown external input at the point where it enters trusted in-process code, using a schema-based approach (currently Zod). Config files loaded from disk are the primary validated boundary; other boundaries (external API JSON, worktree run state, managed manifests) are explicitly deferred.
_Avoid_: Input sanitization, schema enforcement, type guard

**Base Refresh**:
A runner-owned workflow step that rebases a stale preserved **Worktree** or existing branch onto the latest **Target** base branch before resume. The runner checks staleness, runs `git rebase --autostash`, detects conflicts, and owns all Git state transitions. Base Refresh runs only when a preserved Worktree or branch already exists — it does not run on fresh first-time issue runs.
_Avoid_: Agent-driven refresh, human rebase, stale check

**Conflict Resolution Agent**:
An optional agent role under a **Strategy** invoked by the runner when **Base Refresh** results in conflicts. The agent edits conflicted files and writes a structured **Artifact** with `resolved` or `ambiguous` status, a summary, and a file list. The runner retains ownership of `git add`, `git rebase --continue`, and all Git state transitions — the agent only edits files and produces the Artifact. Unlike **Refactor**, which addresses **Reviewer** feedback in a review loop, Conflict Resolution Agent addresses rebase conflicts during resume. Unlike **Reviewer**, it does not evaluate correctness criteria.
_Avoid_: Conflict fixer, merge resolver, conflict handler (unqualified)

**Finding Lineage**:
The chain of related **Reviewer** findings across review iterations, expressed by finding IDs and `Supersedes` links.
_Avoid_: Repeat finding, duplicate issue

**GitHub API Client**:
The runner-owned boundary for Octokit-backed GitHub API operations, handling token and repository resolution.
_Avoid_: Shell-based GitHub tooling (when referring to runtime API operations)

**Human Handoff**:
A workflow transition where a **Reviewer** determines agent iteration should stop and a human decision or action is required.
_Avoid_: Failure, escalation without context

**Refactor Artifact**:
A structured **Artifact** written by a **Refactor** attempt that records how each **Reviewer** finding was handled, verification performed, and open blockers.
_Avoid_: Refactor summary, chat response, fix log

## Relationships

- A **Target** selects one **Strategy** for processing an **Issue**
- A **Target** base branch names the remote-backed lane and PR base, not a local branch Pourkit owns — operator branches named like the Target base are independent and never force-updated by Pourkit
- A **Strategy** owns workflow execution behavior
- A **Worktree** is created per **Issue** for isolated, resumable workflow work
- A **Sandbox** is created around a **Worktree** to run setup commands and agent roles
- A **Builder** works in a **Worktree** to implement an **Issue**
- A **Builder** may invoke the **Advisory Analyzer** for bounded advisory analysis before completion
- A **Reviewer** evaluates the **Builder**'s output and produces an **Artifact**
- A **Refactor** addresses **Reviewer** feedback using the same **Artifact**
- A **Refactor** may invoke the **Advisory Analyzer** after addressing **Reviewer** findings; this does not change Reviewer authority
- A **Run Context** is shared across all agent roles in a workflow run (agent-facing)
- A **Worktree** may contain **Worktree Run State** that allows Pourkit to resume a failed run (runner-owned, not agent-editable)
- A **Queue** contains multiple **Issues** waiting for processing
- A **Queue Loop** processes runnable **Issues** from the **Queue** sequentially until none remain
- A **Queue Loop** reconciles blocked **Issues** before each selection round and after each completed **Issue** is closed
- **Base Refresh** can occur before a **Worktree** resume when the existing branch is stale relative to the **Target** base branch
- **Conflict Resolution Agent** is an optional role under a **Strategy** invoked when **Base Refresh** produces conflicts; the agent edits files and writes an **Artifact**, while the runner owns Git state transitions
- A **Refactor** writes a **Refactor Artifact** after addressing **Reviewer** feedback
- A **Reviewer** reads **Refactor Artifacts** as context, not source of truth
- **Finding Lineage** connects **Reviewer** findings across iterations via IDs and `Supersedes` links
- A **Provider** or **Command** uses the **GitHub API Client** for Octokit-backed GitHub API operations while local repository operations remain `git`
- **Human Handoff** moves the **Issue** to `ready-for-human` when agent iteration should stop

## Example Dialogue

> **Dev:** "Should the reviewer run in the same worktree as the builder?"
> **Domain expert:** "Yes. The reviewer runs in the same Worktree so review/refactor/finalizer state is preserved and resumable with the Issue."

> **Dev:** "What happens when the reviewer finds issues?"
> **Domain expert:** "A refactor agent addresses the feedback. This loop repeats up to the configured max review iterations."

> **Dev:** "Does the queue loop start all issues in parallel?"
> **Domain expert:** "No. The queue loop processes runnable issues one at a time. After each issue is closed, it reconciles blocked issues and checks for remaining runnable work."

## Flagged Ambiguities

- Builder and older implementation-role wording were both plausible; resolved: use **Builder** for the implementation agent role (legacy references in CHANGELOG.md and config rejection guards are historical and kept as-is).
- "agent" was overloaded; resolved: qualify with role (Builder, Reviewer, Refactor, Conflict Resolution Agent, PR Description Agent).

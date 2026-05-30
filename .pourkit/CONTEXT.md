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

**Release Lane**:
A protected branch that carries a distinct publish contract for the Pourkit CLI.
_Avoid_: Environment, deployment branch

**Integration Branch**:
The protected `dev` branch where completed one-off work and completed PRD product increments accumulate before promotion to a Release Lane.
_Avoid_: Development release lane, staging branch

**PRD Branch**:
A temporary branch named exactly `PRD-00N`, created from `dev`, that receives child Issue PRs for one PRD before a final PR back to `dev`.
_Avoid_: Release branch, feature branch (when referring to PRD-scoped queue work)

**Promotion PR**:
A branch-to-branch PR that moves already-merged work forward through the release topology, such as `dev -> next`, `next -> main`, or hotfix reconciliation.
_Avoid_: Feature PR, local publish

**Hotfix**:
An urgent stable-user fix branched from `main` as `hotfix/<slug>`, merged back to `main`, then reconciled forward to `next` and `dev`.
_Avoid_: Normal patch release, workaround

**Development Release**:
An automated npm snapshot of `@pourkit/cli` published from the `next` **Release Lane** under the `next` dist-tag for dogfooding.
_Avoid_: Canary, beta, develop build

**Stable Release**:
An npm release of `@pourkit/cli` published from the `main` **Release Lane** under the `latest` dist-tag after a Changesets Version Packages PR is merged.
_Avoid_: Production deploy, final build

**Changeset**:
A release-note and version-intent file required for user-facing changes so Changesets can calculate the next stable version and changelog.
_Avoid_: Changelog entry, release note file

**Batch Baseline**:
The git revision Serena indexes at the start of a Queue run batch. All parallel Issue Worktrees in the same batch share this baseline context. Agents see only baseline intelligence — symbol info from the base commit, not unmerged sibling Worktree changes. Agents talk to the same Serena sidecar HTTP endpoint regardless of which Worktree they run in.
_Avoid_: Per-Worktree index, live Worktree context

**Serena Baseline Worktree**:
Runner-owned git checkout that Serena indexes, checked out at the active Target's `baseBranch`. Managed by Pourkit CLI through normal git operations. Path on host: `.pourkit/serena/baseline/active-repo/`. Mounted into the Serena sidecar container at `/workspaces/pourkit`.
_Avoid_: Live Worktree checkout, Serena sandbox mount

**Serena Sidecar**:
Long-lived Docker container running Serena MCP server, separate from all Sandcastle containers. Persists across Issue runs. Mounts the Serena Baseline Worktree and Serena data directory. Both Pourkit Sandboxes and host OpenCode connect to it as a remote MCP server over HTTP.
_Avoid_: Ephemeral Serena instance, in-Sandbox Serena

**Snapshot Oracle**:
The property that Serena provides intelligence about the **baseline commit**, not about in-flight Worktree edits. Agents must not use Serena for symbols just introduced in their own Issue Worktree, files changed by a sibling Worktree, post-edit validation of uncommitted diff, or refactoring decisions depending on current agent edits. OpenCode file tools remain source of truth for current Worktree state.
_Avoid_: Live Worktree oracle, real-time symbol provider

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
- Pourkit uses `dev` as the **Integration Branch** for completed work before release promotion
- Pourkit uses `PRD-00N` **PRD Branches** for PRD-scoped Queue work: child Issue PRs merge into the PRD Branch, then the completed PRD Branch merges to `dev`
- Pourkit uses `next` and `main` as **Release Lanes**: `next` publishes **Development Releases**, while `main` publishes **Stable Releases**
- **Promotion PRs** move already-merged work through the branch topology: `dev -> next`, `next -> main`, and hotfix reconciliation `main -> next -> dev`
- A **Hotfix** lands on `main` with its own **Changeset**, then reconciles forward to `next` and `dev` without new Changesets by default
- User-facing Changeset placement depends on branch flow: one-off `dev` PRs carry their own Changesets, child PRD Issue PRs usually do not, final `PRD-00N -> dev` PRs carry one summarized Changeset when user-facing, and `next -> main` promotion does not invent new Changesets
- Internal-only PRs targeting `next` or `main` explicitly opt out with the `no-changeset-needed` label; the label is optional elsewhere and normally not used

## Example Dialogue

> **Dev:** "Should the reviewer run in the same worktree as the builder?"
> **Domain expert:** "Yes. The reviewer runs in the same Worktree so review/refactor/finalizer state is preserved and resumable with the Issue."

> **Dev:** "What happens when the reviewer finds issues?"
> **Domain expert:** "A refactor agent addresses the feedback. This loop repeats up to the configured max review iterations."

> **Dev:** "Does the queue loop start all issues in parallel?"
> **Domain expert:** "No. The queue loop processes runnable issues one at a time. After each issue is closed, it reconciles blocked issues and checks for remaining runnable work."

## Flagged Ambiguities

- Builder and older implementation-role wording were both plausible; resolved: use **Builder** for the implementation agent role (legacy references in config rejection guards are historical and kept as-is).
- "agent" was overloaded; resolved: qualify with role (Builder, Reviewer, Refactor, Conflict Resolution Agent, PR Description Agent).
- "development release" was ambiguous with Git Flow `develop`; resolved: use **Development Release** for npm snapshots from the `next` **Release Lane**, not a separate environment.

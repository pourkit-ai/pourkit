## Scope

- Analyzed prior Worktree: `.sandcastle/worktrees/pourkit-1090-prd-028-i-02-extract-queue-reconciliation-and-loop`
- Issue: `#1090` / `PRD-028 / I-02: Extract Queue reconciliation and loop module`
- Evidence reviewed:
  - `.sandcastle/worktrees/pourkit-1090-prd-028-i-02-extract-queue-reconciliation-and-loop/.pourkit/.tmp/run-context.md`
  - `.sandcastle/worktrees/pourkit-1090-prd-028-i-02-extract-queue-reconciliation-and-loop/.pourkit/.tmp/reviewers/iteration-1.md`
  - `.sandcastle/worktrees/pourkit-1090-prd-028-i-02-extract-queue-reconciliation-and-loop/.pourkit/.tmp/reviewers/iteration-2.md`
  - `.sandcastle/worktrees/pourkit-1090-prd-028-i-02-extract-queue-reconciliation-and-loop/.pourkit/.tmp/reviewers/iteration-3.md`
  - `.sandcastle/worktrees/pourkit-1090-prd-028-i-02-extract-queue-reconciliation-and-loop/.pourkit/.tmp/reviewers/iteration-4.md`
  - `.sandcastle/worktrees/pourkit-1090-prd-028-i-02-extract-queue-reconciliation-and-loop/.pourkit/.tmp/reviewers/iteration-5.md`

## What happened

This Issue passed on review iteration 5 after four review findings:

1. Queue-owned reconciliation still hardcoded `"needs-triage"` instead of using configured label policy.
2. Queue Loop reconciled blocked Issues after any successful Issue run, not only after the blocker actually closed.
3. The selection-policy seam cleanup was incomplete: `TYPE_LABELS` moved from `blocked-issue.ts` to `queue.ts` instead of to a neutral owner, and reconciliation still hardcoded `"ready-for-agent"`.
4. The fix for configured `needs-triage` introduced a new required public config field, breaking previously valid configs.

The churn was mostly upstream-preventable. The Issue was detailed, but it still left enough ambiguity and contradiction for a Builder to make locally reasonable choices that failed review.

## Finding classification

| Iteration | Finding | Classification | Root cause |
| --- | --- | --- | --- |
| 1 | Hardcoded `needs-triage` remained in Queue-owned reconciliation | Preventable by Issue body | Contradictory test guidance and weak regression contract for non-default label values |
| 2 | Post-run reconciliation triggered on success instead of closure | Preventable by Issue body | Missing regression contract for `autoMerge: false` / closure-vs-success semantics |
| 3a | `TYPE_LABELS` policy leak moved to `queue.ts` instead of being rehomed | Preventable by Issue body | Weak ownership/interface contract for shared policy |
| 3b | Reconciliation still hardcoded `ready-for-agent` | Preventable by Issue body | Missing full config-driven label contract |
| 4 | `labels.needsTriage` became required and broke legacy config loading | Preventable by PRD and Issue body | Missing backward-compatibility contract for public config expansion |

## What was preventable upstream

### 1. The Issue mixed a config-driven requirement with a default-literal test sketch

The Issue body correctly said label transitions must use configured names, and the regression contract said the Issue must gain the configured `needs-triage` label. But the step-level test sketch in `run-context.md` still used:

```ts
expect(updatedIssue.labels).toContain("needs-triage");
```

That contradiction invited the Builder to preserve the default literal instead of proving config-driven behavior.

### 2. The Issue described Queue Loop timing in prose, but did not force the key negative case

The Run Context repeatedly said reconciliation happens after a completed Issue closes. But it never named the adjacent failure mode where an Issue run succeeds without closing the Issue, especially `target.autoMerge === false`. That left room for a Builder to equate success with closure.

### 3. The Issue named the seam to remove, but not the new owner strongly enough

The Issue said `blocked-issue.ts` should stop importing `TYPE_LABELS` from `select-issue.ts`, but it did not pin the replacement owner tightly enough in Contracts / interfaces or in a dedicated deletion-plus-rehome step. That made it easy to satisfy the letter of the change by moving the dependency one file over.

### 4. The Issue captured one label transition, but not the full label-policy surface

It explicitly protected `needs-triage`, but did not name `ready-for-agent` as part of the same config-driven label contract. The reviewer found the remaining literal only after the first fix landed.

### 5. Neither the PRD nor the Issue treated public config expansion as backward-compatible by default

Once the Builder tried to make `needsTriage` configurable, the implementation introduced a new required config key. Nothing upstream explicitly said that previously valid configs must keep loading unless the slice was a deliberate migration. That omission caused a high-severity review finding late in the loop.

## Why it kept reaching review

- The Issue had strong prose but incomplete adversarial checks. A Builder could follow the steps and still miss the precise negative case the Reviewer cared about.
- The regression contract protected happy-path semantics better than boundary semantics. The non-default label case, `autoMerge: false` case, and legacy-config case were all nearby behaviors, but not all were forced into concrete test steps.
- The refactor slice named removals informally, not as deletion obligations with a replacement owner. That made the seam cleanup easy to half-complete.
- The planning prompts currently emphasize regression sensitivity, but they do not yet force a planner to resolve contradictions like "configured behavior" plus a default-literal assertion sketch.

## Exact recommended changes for `to-issues`

### Add a new rule under `## Regression contract (CRITICAL)`

Add:

> - If the slice changes hardcoded defaults into configurable behavior, the regression contract must name both behaviors explicitly: (1) the non-default configured behavior that must work, and (2) the pre-existing default/omitted-config behavior that must keep working unless the slice is an explicit migration.

### Add a new rule under `## Step-by-step implementation`

Add:

> - If the issue says behavior is config-driven, no test sketch may assert a default literal unless the assertion is specifically for the omitted-config fallback case. Prefer one test step for a non-default configured value and one regression step for legacy/default behavior.

### Strengthen the existing migration/refactor guidance

Add:

> - For refactor slices that remove a dependency seam, write one explicit deletion step for the old dependency edge and one explicit implementation step that names the new owner. Do not describe seam cleanup only as "stop importing X from Y"; name where the policy or contract lives afterward.

### Add a new adversarial-review question in `### 6. Adversarial review loop`

Add after the current contradiction test:

> 4a. **The default-vs-config test.** If the issue claims behavior is configurable, do any examples, assertions, acceptance criteria, or step notes still hardcode the old default value without also naming whether it is the configured case or the fallback case? If yes, fix the contradiction before publishing.

### Add a second new adversarial-review question

Add:

> 4b. **The success-vs-state-transition test.** If the issue changes looping, orchestration, status handling, or command sequencing, does the issue distinguish successful execution from the state transition that authorizes the next step (for example success vs closure)? If not, add a regression contract bullet and a negative test for the adjacent non-transition case.

### Add a new issue-quality checklist item

Add:

> - [ ] If the slice introduces or expands config-driven behavior, the issue explicitly covers both non-default configured behavior and omitted-config/default fallback behavior.

### Add a second issue-quality checklist item

Add:

> - [ ] Refactor seam removals name both sides of the move: the exact legacy dependency edge being deleted and the exact new owner that replaces it.

## Exact recommended changes for `to-prd`

### Expand `## Implementation Decisions`

Add:

> - If the work changes a hardcoded default into configurable behavior, state whether this is a backward-compatible expansion or an explicit migration. Name the fallback behavior for omitted config and whether existing repositories must remain loadable without adding a new key.

Add:

> - If the work extracts ownership across module seams, name the new canonical owner of each shared policy or contract. Do not only say which old dependency should disappear.

### Expand `## Testing Decisions`

Add:

> - When orchestration or loop sequencing changes, include at least one test decision for the adjacent non-transition case, where the command succeeds but the state change that normally triggers downstream work has not happened yet.

Add:

> - When a feature becomes config-driven, include at least one test for a non-default configured value and at least one test proving omitted-config/default behavior remains compatible unless the PRD is explicitly a migration.

### Add a new planning heuristic near the module sketch step

Add:

> - For every policy or constant being moved out of an existing module seam, decide and record its long-term owner before writing the PRD. `No longer imported from X` is not enough; the PRD must say where it lives next.

## Optional model-routing note

No model-routing change is justified from this evidence alone. The reviewer caught the problems accurately; the repeated churn points to planning gaps, not primarily Builder weakness.

## Recommended next action

Update both `to-issues` and `to-prd`.

`to-issues` is the higher-leverage change because three of the four findings came from Issue-level ambiguity or contradiction. `to-prd` should also be tightened so future PRDs explicitly encode backward-compatibility expectations for public config and ownership decisions for extracted seams.

# ADR 0009: Advisory Analyzer and Prefixed OpenCode Agents

## Status

Accepted

## Context

Pourkit's deterministic review loop depends on the Reviewer as the only authoritative role that writes review artifacts and emits official verdict tokens. Builder and Refactor can still benefit from a cheap, bounded defect check before handing work to the next workflow step, but that check must not become a shadow review stage.

OpenCode agent identities also need to be explicit in project-local configuration so Pourkit roles do not collide with generic built-in agent names.

## Decision

Define project-local OpenCode primary agents named `pourkit-builder`, `pourkit-reviewer`, `pourkit-refactor`, and `pourkit-pr-description`.

Define a hidden subagent named `advisory-analyzer` with a prompt loaded from `.pourkit/prompts/advisory-analyzer.prompt.md`. Builder and Refactor may invoke it through task permissions. Reviewer and PR Description Agent may not invoke tasks.

The Advisory Analyzer is read-only, advisory only, writes no artifacts, and uses `<advisory>...</advisory>` tokens instead of official `<verdict>...</verdict>` tokens. Builder and Refactor prompts bound usage to at most three analyzer calls per stage execution.

The official Reviewer remains the only authority for review artifacts, review verdicts, and the review/refactor loop.

## Consequences

- Builder and Refactor get a bounded conversational check without adding a deterministic workflow stage.
- Refactor Artifacts may include an optional Advisory Analyzer Responses section to record how advisory findings were handled.
- Official review parsing stays isolated to Reviewer artifacts and `<verdict>...</verdict>` tokens.
- Project-local OpenCode config changes require restarting OpenCode before they take effect.

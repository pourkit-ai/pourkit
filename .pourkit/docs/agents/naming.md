# Issue Naming

## PRDs

Format: `PRD-00N: <short title>`

Rules:
- `PRD-00N` is the canonical identifier
- PRD numbering is global across the repo
- Titles should describe the initiative, not workflow state
- Do not include labels or execution mode in the title

Examples:
- `PRD-001: AI-driven issue-to-PR workflow MVP`
- `PRD-002: Review-refactor loop with configurable max iterations`

## Child Issues

Format: `PRD-00N / I-0N: <short slice title>`

Rules:
- Child issue numbering is local to the parent PRD
- `I-01`, `I-02`, etc. are assigned when issues are created
- Do not include `HITL`, `AFK`, or triage state in the title
- Keep the title slice-oriented and stable over time

Examples:
- `PRD-002 / I-01: Implement reviewer agent stage`
- `PRD-002 / I-02: Implement refactor agent stage`

## Workflow Metadata

Keep these out of titles and in labels/body only:
- `needs-triage`
- `needs-info`
- `ready-for-agent`
- `ready-for-human`
- `wontfix`
- `HITL`
- `AFK`

## Parent Linkage

Every child issue should include its parent PRD in the body under `## Parent`, even though the title already includes the PRD ID.

## Reference Style

Prefer canonical IDs in discussion:
- `PRD-002`
- `PRD-002 / I-03`

Use GitHub issue numbers as secondary references when helpful:
- `PRD-002 / I-03 (#36)`

## Stability

Once assigned, PRD and child issue IDs should not be renumbered.
If an issue is abandoned, later issues keep their existing IDs.

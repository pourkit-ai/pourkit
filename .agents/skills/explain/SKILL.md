---
name: explain
description: Explain concepts with large visual ASCII diagrams first, then brief plain-language text for non-technical readers. Use when user asks to explain, teach, clarify, understand, visualize, diagram, or make a concept intuitive.
---

# Explain

Use this skill to explain concepts visually. Diagram is the main answer. Text supports diagram. The examples file is part of the skill, not optional background.

## Core Rule

Diagram first. Text second.

Before answering, consult [EXAMPLES.md](EXAMPLES.md) as the visual reference when tool access is available. If the file is not available in context, use the example signatures below. Pick the closest example style, then adapt its scale, spacing, box density, arrows, labels, and metaphor to the user's concept.

## Workflow

1. Identify the concept's shape: flow, map, hierarchy, containment, cycle, comparison, or control boundary.
2. Choose one closest reference from [EXAMPLES.md](EXAMPLES.md): brainstorming map, mental model, creative system map, containment/ownership, or technical workflow.
3. Borrow the chosen reference's visual grammar: title placement, generous whitespace, multi-region layout, clear arrows, named boxes, and one-line labels.
4. Draw a large ASCII/Unicode model that makes structure visible.
5. Add brief plain-language explanation for a smart non-technical reader.
6. If topic is technical, bridge terms with simple metaphors before naming machinery.

## Diagram Selection

- Brainstorming: loose map of idea clusters, unknowns, and paths.
- Mental model: big metaphorical system that captures the whole idea.
- Creative system: roads, rooms, desks, bins, packets, gates, stations.
- Containment: big boxes with smaller systems inside to show ownership.
- Relationship: side-by-side systems with arrows for control or handoff.
- Technical workflow: states, boundaries, inputs, outputs, contracts.

## Example Signatures

- Brainstorming map: wide title, fuzzy cloud, 3 idea boxes, convergence into one candidate, unknowns orbiting outside.
- Mental model: friendly metaphor, large named actors, side path for lookup/helper system, environment band across middle, final result box.
- Creative system map: opening claim box, small pieces split apart, sorting room/handoff hub, multiple routes, rebuilt result.
- Containment/ownership: one large outer boundary owning sequence, nested inner boundary for delegated focused work, outcome returns upward.
- Technical workflow: input source panel, explicit state machine, execution boundary, outcome contract with success/failure cases.

## Style Rules

- The answer should visibly resemble one of the examples in construction quality, not just contain any diagram.
- Make diagram large enough to be useful, not decorative.
- Use at least 12 lines for the diagram unless user asks for a tiny answer.
- Vary layout; do not default to top-down pipeline.
- Use horizontal flow, nested boxes, maps, loops, and side-by-side panels when fitting.
- Prefer visual labels over dense paragraphs inside diagram.
- Use arrows to show movement, control, handoff, or dependency.
- Use named regions like rooms, desks, rails, bins, gates, hubs, and stations.
- Keep post-diagram prose short: 1-4 small paragraphs.
- Explain like reader is smart but non-technical, similar to a curious child.
- Avoid condescension, jargon walls, and long essays unless user asks for depth.

## Quality Check

Before final answer, check:

- Did I choose a specific example style from [EXAMPLES.md](EXAMPLES.md)?
- Would the diagram still teach something if the prose were deleted?
- Does it use spacious structure like the examples, not a tiny bullet list with arrows?
- Does it avoid defaulting to a simple vertical pipeline unless that is truly the concept's shape?

## Explanation Shape

After diagram, briefly explain:

- what it is
- what parts matter
- how pieces relate
- simple version

## Technical Topics

For technical systems, show boundaries explicitly:

- who owns what
- what crosses the boundary
- what waits, retries, or stops
- what success and failure look like
- what result returns to caller

Use technical names when useful, but anchor them in plain meaning.

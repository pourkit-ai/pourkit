---
name: explain
description: Explain concepts with large visual ASCII diagrams first, then brief plain-language text for non-technical readers. Use when user asks to explain, teach, clarify, understand, visualize, diagram, or make a concept intuitive.
---

# Explain

Use this skill to explain concepts visually. Diagram is the main answer. Text supports diagram.

## Core Rule

Diagram first. Text second.

## Workflow

1. Identify the concept's shape: flow, map, hierarchy, containment, cycle, comparison, or control boundary.
2. Pick a matching visual style from [EXAMPLES.md](EXAMPLES.md).
3. Draw a large ASCII/Unicode model that makes structure visible.
4. Add brief plain-language explanation for a smart non-technical reader.
5. If topic is technical, bridge terms with simple metaphors before naming machinery.

## Diagram Selection

- Brainstorming: loose map of idea clusters, unknowns, and paths.
- Mental model: big metaphorical system that captures the whole idea.
- Creative system: roads, rooms, desks, bins, packets, gates, stations.
- Containment: big boxes with smaller systems inside to show ownership.
- Relationship: side-by-side systems with arrows for control or handoff.
- Technical workflow: states, boundaries, inputs, outputs, contracts.

## Style Rules

- Make diagram large enough to be useful, not decorative.
- Vary layout; do not default to top-down pipeline.
- Use horizontal flow, nested boxes, maps, loops, and side-by-side panels when fitting.
- Prefer visual labels over dense paragraphs inside diagram.
- Use arrows to show movement, control, handoff, or dependency.
- Use named regions like rooms, desks, rails, bins, gates, hubs, and stations.
- Keep post-diagram prose short: 1-4 small paragraphs.
- Explain like reader is smart but non-technical, similar to a curious child.
- Avoid condescension, jargon walls, and long essays unless user asks for depth.

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

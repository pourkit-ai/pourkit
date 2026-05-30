# Architect Skill

Command-driven architectural continuity skill for turning large grill/planning sessions into durable initiative state under `.pourkit/architecture`.

## Install

Copy the `architect/` folder into your skills directory.

## Canonical write location

Architect writes project state to:

```txt
.pourkit/architecture/
```

## Common commands

```txt
Architect: init <initiative title>
Architect: compress
Architect: status
Architect: next
Architect: publish PRD
Architect: breakdown
Architect: reconcile
Architect: update
Architect: list
```

## Core workflow

```txt
grill-with-docs session
  → Architect: compress
  → Architect: status
  → Architect: next
  → Architect: publish PRD
  → Architect: breakdown
  → queue-run --prd PRD-00N
  → implement one PRD
  → Architect: reconcile
  → Architect: next
```

Architect should not contain baked-in example initiatives. It creates initiatives only from user-provided or session-inferred titles.

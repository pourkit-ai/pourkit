# Explain Diagram Examples

Use these as style references, not rigid templates. Match diagram shape to concept.

## 1. Brainstorming Map

Use for early ideas, planning, strategy, or messy concepts where relationships matter more than order.

```text
                         PRODUCT PLANNING AS A THINKING MAP

                 . . . fuzzy idea cloud . . .
              .                                  .
           .        "make onboarding better"       .
              .                                  .
                 ' . . . . . . . . . . . . . '
                              |
          .-------------------+-------------------.
          |                   |                   |
          v                   v                   v

   ╭──────────────╮    ╭──────────────╮    ╭──────────────╮
   │ USER PAIN    │    │ BUSINESS WHY │    │ TECH SHAPE   │
   │              │    │              │    │              │
   │ confused     │    │ fewer drops  │    │ screens      │
   │ lost         │    │ more success │    │ data         │
   │ slow start   │    │ trust        │    │ edge cases   │
   ╰──────────────╯    ╰──────────────╯    ╰──────────────╯
          |                   |                   |
          '-------------------+-------------------'
                              |
                              v

                     ╔══════════════════════╗
                     ║    PLAN CANDIDATE    ║
                     ║                      ║
                     ║ smaller first slice  ║
                     ║ clear success signal ║
                     ║ known tradeoffs      ║
                     ╚══════════════════════╝

        unknowns orbit outside until they become clear enough to enter

       (?) analytics missing     (?) which users     (?) launch risk
```

Product planning starts as fog. You separate pain, reason, and build shape until one small useful slice appears.

## 2. Mental Model

Use for explaining common technical ideas with a friendly metaphor.

```text
                         HOW A WEBSITE APPEARS ON YOUR SCREEN

       You ask for a site
              |
              v
       .--------------.        asks: "where does this live?"
       |   BROWSER    | ------------------------------------.
       '--------------'                                     |
              |                                             v
              |                                  ╭────────────────────╮
              |                                  │ DNS PHONEBOOK      │
              |                                  │                    │
              |                                  │ name -> address    │
              |                                  ╰────────────────────╯
              |                                             |
              v                                             v

 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ internet roads, wires, routers ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

              |                                             |
              v                                             v
       ╔════════════════╗                         ╔════════════════════╗
       ║ WEBSITE SERVER ║                         ║ PAGE INGREDIENTS   ║
       ║                ║                         ║                    ║
       ║ kitchen making ║ ----------------------> ║ HTML bones         ║
       ║ webpage meal   ║                         ║ CSS clothes        ║
       ╚════════════════╝                         ║ JS motion          ║
                                                  ║ images pictures    ║
                                                  ╚════════════════════╝
                                                            |
                                                            v
       ╔══════════════════════════════════════════════════════════════╗
       ║                         YOUR SCREEN                         ║
       ║                                                              ║
       ║ browser assembles ingredients into finished page             ║
       ╚══════════════════════════════════════════════════════════════╝
```

Browser asks where site lives, server sends page pieces, browser assembles them into what you see.

## 3. Creative System Map

Use for distributed systems, networks, queues, or invisible movement.

```text
                         THE INTERNET AS A GIANT POST OFFICE

╔══════════════════════════════════════════════════════════════════════╗
║ You do not throw one giant message across world.                    ║
║ Message becomes tiny envelopes that travel through many sorting rooms.║
╚══════════════════════════════════════════════════════════════════════╝

          "show me cat videos"
                    |
                    v
       ╭────────────┬────────────┬────────────╮
       │ packet 1   │ packet 2   │ packet 3   │
       │ show me    │ cat        │ videos     │
       ╰─────┬──────╯─────┬──────╯─────┬──────╯
             |            |            |
             v            v            v

       ╔════════════════════════════════════════╗
       ║          ROUTER SORTING ROOM           ║
       ║ looks at address labels, picks roads   ║
       ╚════════════════════════════════════════╝
             |            |            |
             v            v            v
      city road     ocean cable     cloud relay
             |            |            |
             '------------+------------'
                          v

                    ╔══════════════╗
                    ║ SERVER DESK  ║
                    ║              ║
                    ║ packet 2     ║
                    ║ packet 1     ║
                    ║ packet 3     ║
                    ║              ║
                    ║ sorts back   ║
                    ║ into order   ║
                    ╚══════════════╝
                          |
                          v
              rebuilt request -> response packets -> your screen
```

Internet sends little packets through many handoffs. They may arrive out of order, then get rebuilt.

## 4. Containment / Ownership

Use when one system owns a bigger process and another system handles a selected piece.

```text
                 QUEUE-RUN + ISSUE EXECUTION AS NESTED OWNERSHIP

╔══════════════════════════════════════════════════════════════════════╗
║                              QUEUE-RUN                              ║
║                                                                      ║
║ owns many issues over time: order, selection, pause, next move       ║
║                                                                      ║
║  ╭──────────╮   ╭──────────╮   ╭──────────╮   ╭──────────╮          ║
║  │ issue #1 │ → │ issue #2 │ → │ issue #3 │ → │ issue #4 │          ║
║  │ ready    │   │ ready    │   │ ready    │   │ ready    │          ║
║  ╰──────────╯   ╰──────────╯   ╰──────────╯   ╰──────────╯          ║
║       │                                                              ║
║       │ selected issue enters worker boundary                        ║
║       v                                                              ║
║                                                                      ║
║  ╔══════════════════════════════════════════════════════════════╗    ║
║  ║                     ISSUE EXECUTION RUN                      ║    ║
║  ║                                                              ║    ║
║  ║ owns one issue right now: understand, branch, code, test, PR ║    ║
║  ║                                                              ║    ║
║  ║  read issue → prepare branch → edit/test → package outcome   ║    ║
║  ╚══════════════════════════════════════════════════════════════╝    ║
║       │                                                              ║
║       │ outcome returns: success, blocked, failed, skipped           ║
║       v                                                              ║
║                                                                      ║
║  queue-run updates queue pointer, then decides next issue or stop    ║
╚══════════════════════════════════════════════════════════════════════╝
```

Queue-run is manager of line. Issue execution is focused worker for one selected card.

## 5. Technical Workflow

Use when user wants a more exact explanation of state, contracts, or execution boundaries.

```text
                 QUEUE-RUN ORCHESTRATOR MODEL

 INPUT SOURCE                         QUEUE-RUN STATE MACHINE

╭──────────────────────╮        ╔══════════════════════════════════════╗
│ GitHub issues         │        ║ IDLE                                ║
│                       │        ║  │                                   ║
│ labels / filters      │───────▶║  v                                   ║
│ ready-for-agent       │        ║ SELECTED                            ║
│ not blocked           │        ║  │ create isolated execution         ║
│ not in progress       │        ║  v                                   ║
╰──────────────────────╯        ║ RUNNING                              ║
                                ║  │ wait for terminal outcome          ║
                                ║  v                                   ║
                                ║ CLASSIFY RESULT                      ║
                                ║  ├─ success -> next issue             ║
                                ║  ├─ blocked -> pause/report           ║
                                ║  ├─ failed  -> retry/report           ║
                                ║  └─ empty   -> done                   ║
                                ╚══════════════════════════════════════╝
                                                  |
                                                  v
╔══════════════════════════════════════════════════════════════════════╗
║                        ISSUE EXECUTION BOUNDARY                     ║
║                                                                      ║
║ load issue -> prepare worktree -> implementation loop -> package PR  ║
║                                                                      ║
║ returns structured outcome, not vibes                               ║
╚══════════════════════════════════════════════════════════════════════╝
                                                  |
                                                  v
╔══════════════════════════════════════════════════════════════════════╗
║                          OUTCOME CONTRACT                           ║
║                                                                      ║
║ SUCCESS: branch, commit, PR, checks described                        ║
║ BLOCKED: human input needed, reason explicit                         ║
║ FAILED: verification or environment prevented completion             ║
║ SKIPPED: issue no longer eligible                                    ║
╚══════════════════════════════════════════════════════════════════════╝
```

Queue-run is orchestrator. It selects eligible issue, starts isolated execution, receives outcome, and changes queue state.

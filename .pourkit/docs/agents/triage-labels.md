# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| `blocked`                  | `blocked`            | Has unresolved dependencies              |
| `type:bugfix`              | `type:bugfix`        | Priority label — bugfix (1)              |
| `type:infra`               | `type:infra`         | Priority label — infrastructure (2)      |
| `type:feature`             | `type:feature`       | Priority label — feature (3)             |
| `type:polish`              | `type:polish`        | Priority label — polish (4)              |
| `type:refactor`            | `type:refactor`      | Priority label — refactor (5)            |

## Label semantics for Pourkit

- `ready-for-agent` without `blocked`: Pourkit may pick this issue.
- `ready-for-agent` with `blocked`: Pourkit skips this issue during normal selection (dependencies unresolved).
- In queue loop mode, Pourkit may reconcile blocked labels before selecting runnable work — a blocked issue remains blocked until its dependencies are resolved.
- AFK-track issues must carry exactly one `type:*` label. Pourkit rejects issues missing one or carrying more than one.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

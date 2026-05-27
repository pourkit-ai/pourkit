const PROTECTED_WORK_RULE =
  "Do **not** revert, delete, or substantially strip already-landed protected sibling/base work unless the issue explicitly requires those files.";

export function appendProtectedWorkGuidance(promptBody: string): string {
  return `${promptBody}

## Hard Rule

- ${PROTECTED_WORK_RULE}`;
}

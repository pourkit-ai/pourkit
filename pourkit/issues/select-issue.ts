import { TYPE_LABELS } from "../shared/common";

export type TypeLabel = (typeof TYPE_LABELS)[number];

const TYPE_PRIORITY: Record<TypeLabel, number> = {
  "type:bugfix": 1,
  "type:infra": 2,
  "type:feature": 3,
  "type:polish": 4,
  "type:refactor": 5,
};

export type CandidateIssue = {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
};

export type SelectionResult =
  | { ok: true; issue: CandidateIssue }
  | { ok: false; reason: string };

export interface SelectIssueOptions {
  blockedLabel?: string;
  agentInProgressLabel?: string;
}

export function selectIssue(
  candidates: CandidateIssue[],
  options: SelectIssueOptions = {}
): SelectionResult {
  const blockedLabel = options.blockedLabel ?? "blocked";
  const agentInProgressLabel =
    options.agentInProgressLabel ?? "agent-in-progress";

  if (candidates.length === 0) {
    return { ok: false, reason: "No candidate issues provided." };
  }

  const unblocked = candidates.filter(
    (issue) => !issue.labels.includes(blockedLabel)
  );

  if (unblocked.length === 0) {
    return { ok: false, reason: "All candidate issues are blocked." };
  }

  const valid: Array<{ issue: CandidateIssue; priority: number }> = [];
  const rejected: string[] = [];

  for (const issue of unblocked) {
    if (issue.labels.includes(agentInProgressLabel)) {
      rejected.push(
        `Issue #${issue.number} is labeled ${agentInProgressLabel}.`
      );
      continue;
    }

    const typeLabels = issue.labels.filter((l): l is TypeLabel =>
      (TYPE_LABELS as readonly string[]).includes(l)
    );

    if (typeLabels.length !== 1) {
      rejected.push(
        `Issue #${issue.number} has ${typeLabels.length} type label(s); expected exactly one.`
      );
      continue;
    }

    valid.push({ issue, priority: TYPE_PRIORITY[typeLabels[0]] });
  }

  if (valid.length === 0) {
    return {
      ok: false,
      reason: "No runnable issues: " + rejected.join(" "),
    };
  }

  valid.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ageCmp = a.issue.createdAt.localeCompare(b.issue.createdAt);
    if (ageCmp !== 0) return ageCmp;
    return a.issue.number - b.issue.number;
  });

  return { ok: true, issue: valid[0].issue };
}

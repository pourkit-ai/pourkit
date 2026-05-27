export type BlockedIssue = {
  number: number;
  body: string | null;
  labels?: Array<{ name: string }>;
};

import type { IssueTransitionsContract } from "./issue-transitions";

export type ReconcileDependencies = {
  getIssueState: (issueNumber: number) => Promise<string>;
  transitions: IssueTransitionsContract;
  typeLabels: readonly string[];
  readyLabel: string;
};

export type ReconcileResult = "still-blocked" | "unblocked" | "needs-triage";

export type ReconcileBlockedIssuesResult = {
  issueNumber: number;
  result: ReconcileResult;
};

export function parseBlockedBy(body: string | null): number[] {
  if (!body) return [];

  const bm = body.match(/## Blocked by\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (!bm) return [];

  const refs: number[] = [];
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(bm[1])) !== null) {
    refs.push(Number(m[1]));
  }
  return refs;
}

export async function reconcileBlockedIssue(
  issue: BlockedIssue,
  deps: ReconcileDependencies
): Promise<ReconcileResult> {
  const blockers = parseBlockedBy(issue.body);

  if (blockers.length === 0) {
    await deps.transitions.moveToNeedsTriage(issue.number);
    return "needs-triage";
  }

  const stillBlocked = await anyBlockerStillOpen(blockers, deps.getIssueState);
  if (stillBlocked) {
    return "still-blocked";
  }

  const labels = issue.labels ?? [];
  const typeLabels = labels.filter((l) => deps.typeLabels.includes(l.name));

  if (typeLabels.length === 1) {
    await deps.transitions.removeBlocked(issue.number);
    const alreadyReady = labels.some((l) => l.name === deps.readyLabel);
    if (!alreadyReady) {
      await deps.transitions.addReadyForAgent(issue.number);
    }
    return "unblocked";
  }

  await deps.transitions.moveToNeedsTriage(issue.number);
  return "needs-triage";
}

export async function reconcileBlockedIssues(
  issues: BlockedIssue[],
  deps: ReconcileDependencies
): Promise<ReconcileBlockedIssuesResult[]> {
  const results: ReconcileBlockedIssuesResult[] = [];

  for (const issue of issues) {
    const result = await reconcileBlockedIssue(issue, deps);
    results.push({ issueNumber: issue.number, result });
  }

  return results;
}

async function anyBlockerStillOpen(
  refs: number[],
  getIssueState: (issueNumber: number) => Promise<string>
): Promise<boolean> {
  for (const ref of refs) {
    const state = await getIssueState(ref);
    if (state !== "CLOSED") {
      return true;
    }
  }

  return false;
}

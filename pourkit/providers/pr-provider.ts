export interface PullRequest {
  number: number;
  nodeId: string;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
}

export interface CheckStatus {
  conclusion:
    | "SUCCESS"
    | "FAILURE"
    | "NEUTRAL"
    | "SKIPPED"
    | "STALE"
    | "STARTUP_FAILURE"
    | "CANCELLED"
    | "TIMED_OUT"
    | "ACTION_REQUIRED"
    | null;
  status:
    | "QUEUED"
    | "IN_PROGRESS"
    | "COMPLETED"
    | "WAITING"
    | "PENDING"
    | "REQUESTED"
    | null;
  name: string;
}

export interface BranchStatus {
  headSha: string;
  state: "green" | "pending" | "red";
  checks: CheckStatus[];
}

export interface PRProvider {
  createPr(options: CreatePrOptions): Promise<PullRequest>;
  getPr(branchName: string): Promise<PullRequest | null>;
  getCheckStatus(prNumber: number): Promise<CheckStatus[]>;
  mergePr(prNumber: number, options?: MergePrOptions): Promise<void>;
  enableAutoMerge(
    pr: PullRequest,
    options?: EnableAutoMergeOptions
  ): Promise<void>;
  waitForPrChecks(
    prNumber: number,
    options?: WaitForPrChecksOptions
  ): Promise<CheckStatus[]>;
  getBranchStatus(branchName: string): Promise<BranchStatus>;
}

export interface CreatePrOptions {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface WaitForPrChecksOptions {
  checksFoundTimeoutMs?: number;
  checksCompletionTimeoutMs?: number;
  pollIntervalMs?: number;
  requiredChecks?: string[];
}

export interface MergePrOptions {
  method?: "merge" | "squash" | "rebase";
  matchHeadCommit?: string;
}

export interface EnableAutoMergeOptions {
  method?: "merge" | "squash" | "rebase";
  expectedHeadOid?: string;
}

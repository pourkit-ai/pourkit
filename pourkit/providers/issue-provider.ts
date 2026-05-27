import type { IssueData } from "../shared/config";
import { parseStackedIssue } from "../issues/stacked-issue";
import type { BlockedIssue } from "../issues/blocked-issue";

export interface IssueProvider {
  fetchIssue(number: number): Promise<IssueData>;
  listCandidates(): Promise<IssueData[]>;
  listBlockedIssues(): Promise<BlockedIssue[]>;
  listRelatedIssues(parentRef: string): Promise<IssueData[]>;
  resolveIssueByCanonicalRef(ref: string): Promise<IssueData | null>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  getComments(issueNumber: number): Promise<string[]>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
}

export class FakeIssueProvider implements IssueProvider {
  private issues: Map<number, IssueData> = new Map();
  private readonly readyForAgentLabel: string;
  private readonly blockedLabel: string;

  constructor(
    issues: IssueData[] = [],
    options?: { readyForAgentLabel?: string; blockedLabel?: string }
  ) {
    this.readyForAgentLabel = options?.readyForAgentLabel ?? "ready-for-agent";
    this.blockedLabel = options?.blockedLabel ?? "blocked";
    for (const issue of issues) {
      this.issues.set(issue.number, { ...issue });
    }
  }

  async fetchIssue(number: number): Promise<IssueData> {
    const issue = this.issues.get(number);
    if (!issue) {
      throw new Error(`Issue ${number} not found`);
    }
    return { ...issue, comments: [...issue.comments] };
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) {
      for (const label of labels) {
        if (!issue.labels.includes(label)) {
          issue.labels.push(label);
        }
      }
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.labels = issue.labels.filter((l) => l !== label);
    }
  }

  async getComments(issueNumber: number): Promise<string[]> {
    const issue = this.issues.get(issueNumber);
    return issue ? [...issue.comments] : [];
  }

  async listCandidates(): Promise<IssueData[]> {
    return Array.from(this.issues.values())
      .filter(
        (issue) =>
          issue.state === "open" &&
          issue.labels.includes(this.readyForAgentLabel)
      )
      .map((issue) => ({
        ...issue,
        labels: [...issue.labels],
        comments: [...issue.comments],
      }));
  }

  async listBlockedIssues(): Promise<BlockedIssue[]> {
    return Array.from(this.issues.values())
      .filter(
        (issue) =>
          issue.state === "open" && issue.labels.includes(this.blockedLabel)
      )
      .map((issue) => ({
        number: issue.number,
        body: issue.body,
        labels: issue.labels.map((l) => ({ name: l })),
      }));
  }

  async listRelatedIssues(parentRef: string): Promise<IssueData[]> {
    return Array.from(this.issues.values())
      .filter((issue) => {
        const parsed = parseStackedIssue(issue.title, issue.body);
        return parsed.parentRef === parentRef;
      })
      .map((issue) => ({
        ...issue,
        labels: [...issue.labels],
        comments: [...issue.comments],
      }));
  }

  async resolveIssueByCanonicalRef(ref: string): Promise<IssueData | null> {
    const canonical = ref.trim().toUpperCase();
    const issue = Array.from(this.issues.values()).find((issue) =>
      issue.title.toUpperCase().startsWith(`${canonical}:`)
    );
    if (!issue) return null;
    return {
      ...issue,
      labels: [...issue.labels],
      comments: [...issue.comments],
    };
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.comments.push(body);
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.state = "closed";
    }
  }
}

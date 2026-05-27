import type { IssueData } from "../shared/config";
import { parseStackedIssue } from "../issues/stacked-issue";
import type { BlockedIssue } from "../issues/blocked-issue";
import type { IssueProvider } from "./issue-provider";
import type { GitHubClient } from "./github-client";

export class GitHubIssueProvider implements IssueProvider {
  private readonly client: GitHubClient;
  private readonly readyForAgentLabel: string;
  private readonly blockedLabel: string;
  private readonly issueListLimit: number;

  constructor(
    client: GitHubClient,
    options?: {
      readyForAgentLabel?: string;
      blockedLabel?: string;
      issueListLimit?: number;
    }
  ) {
    this.client = client;
    this.readyForAgentLabel = options?.readyForAgentLabel ?? "ready-for-agent";
    this.blockedLabel = options?.blockedLabel ?? "blocked";
    this.issueListLimit = options?.issueListLimit ?? 50;
  }

  async fetchIssue(number: number): Promise<IssueData> {
    const { data } = await this.client.octokit.rest.issues.get({
      owner: this.client.owner,
      repo: this.client.repo,
      issue_number: number,
    });

    const commentsData = await this.client.octokit.paginate(
      this.client.octokit.rest.issues.listComments,
      {
        owner: this.client.owner,
        repo: this.client.repo,
        issue_number: number,
      }
    );

    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state as "open" | "closed",
      labels: data.labels.map((l) =>
        typeof l === "string" ? l : (l.name ?? "")
      ),
      comments: commentsData.map((c) => c.body ?? ""),
    };
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.client.octokit.rest.issues.addLabels({
      owner: this.client.owner,
      repo: this.client.repo,
      issue_number: issueNumber,
      labels,
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    await this.client.octokit.rest.issues.removeLabel({
      owner: this.client.owner,
      repo: this.client.repo,
      issue_number: issueNumber,
      name: label,
    });
  }

  async closeIssue(issueNumber: number): Promise<void> {
    const { data } = await this.client.octokit.rest.issues.get({
      owner: this.client.owner,
      repo: this.client.repo,
      issue_number: issueNumber,
    });
    if (data.pull_request) return;

    const maxRetries = 3;
    const backoffMs = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.client.octokit.rest.issues.update({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          state: "closed",
          state_reason: "completed",
        });
        return;
      } catch (error) {
        const isTransient =
          error instanceof Error && /HTTP (502|503|504)\b/.test(error.message);
        const isOctokitTransient =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error.status === 502 ||
            error.status === 503 ||
            error.status === 504);
        if ((!isTransient && !isOctokitTransient) || attempt === maxRetries) {
          throw error;
        }
        await new Promise((r) =>
          setTimeout(r, backoffMs * Math.pow(2, attempt - 1))
        );
      }
    }
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    await this.client.octokit.rest.issues.createComment({
      owner: this.client.owner,
      repo: this.client.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async getComments(issueNumber: number): Promise<string[]> {
    const data = await this.client.octokit.paginate(
      this.client.octokit.rest.issues.listComments,
      {
        owner: this.client.owner,
        repo: this.client.repo,
        issue_number: issueNumber,
      }
    );
    return data.map((comment) => comment.body ?? "");
  }

  async listCandidates(): Promise<IssueData[]> {
    const data = await this.client.octokit.paginate(
      this.client.octokit.rest.issues.listForRepo,
      {
        owner: this.client.owner,
        repo: this.client.repo,
        state: "open",
        labels: this.readyForAgentLabel,
        per_page: 100,
      }
    );

    return data
      .filter((issue) => !issue.pull_request)
      .map((issue) => mapRawIssue(issue))
      .slice(0, this.issueListLimit);
  }

  async listBlockedIssues(): Promise<BlockedIssue[]> {
    const data = await this.client.octokit.paginate(
      this.client.octokit.rest.issues.listForRepo,
      {
        owner: this.client.owner,
        repo: this.client.repo,
        state: "open",
        labels: this.blockedLabel,
        per_page: 100,
      }
    );

    return data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        body: issue.body ?? null,
        labels: issue.labels.map((l) => ({
          name: typeof l === "string" ? l : (l.name ?? ""),
        })),
      }))
      .slice(0, this.issueListLimit);
  }

  async listRelatedIssues(parentRef: string): Promise<IssueData[]> {
    const data = await this.client.octokit.paginate(
      this.client.octokit.rest.issues.listForRepo,
      {
        owner: this.client.owner,
        repo: this.client.repo,
        state: "all",
        per_page: 100,
      }
    );

    return data
      .filter((issue) => !issue.pull_request)
      .map((issue) => mapRawIssue(issue))
      .slice(0, this.issueListLimit)
      .filter(
        (issue) =>
          parseStackedIssue(issue.title, issue.body).parentRef === parentRef
      );
  }

  async resolveIssueByCanonicalRef(ref: string): Promise<IssueData | null> {
    const canonical = ref.trim().toUpperCase();
    const data = await this.client.octokit.paginate(
      this.client.octokit.rest.issues.listForRepo,
      {
        owner: this.client.owner,
        repo: this.client.repo,
        state: "all",
        per_page: 100,
      }
    );

    const match = data
      .filter((issue) => !issue.pull_request)
      .slice(0, this.issueListLimit)
      .find((issue) => issue.title.toUpperCase().startsWith(`${canonical}:`));
    if (!match) return null;
    return mapRawIssue(match);
  }
}

function mapRawIssue(issue: {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<{ name?: string | null } | string>;
  created_at?: string | null;
}): IssueData {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state.toLowerCase() as "open" | "closed",
    labels: issue.labels.map((l) =>
      typeof l === "string" ? l : (l.name ?? "")
    ),
    comments: [],
    createdAt: new Date(issue.created_at ?? ""),
  };
}

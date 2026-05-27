export interface IssueTransitionLabels {
  blocked: string;
  readyForAgent: string;
  needsTriage: string;
  agentInProgress: string;
  readyForHuman: string;
  prOpenAwaitingMerge: string;
}

export interface IssueTransitionsContract {
  removeBlocked(issueNumber: number): Promise<void>;
  addReadyForAgent(issueNumber: number): Promise<void>;
  moveToNeedsTriage(issueNumber: number): Promise<void>;
  moveToReadyForHuman(issueNumber: number): Promise<void>;
  closeCompleted(issueNumber: number): Promise<void>;
}

export interface IssueTransitionDeps {
  fetchIssue(issueNumber: number): Promise<{ labels: string[] }>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  closeIssue?(issueNumber: number): Promise<void>;
  updateLabels?(
    issueNumber: number,
    removes: string[],
    adds: string[]
  ): Promise<void>;
}

export function createIssueTransitions(
  deps: IssueTransitionDeps,
  labels: IssueTransitionLabels
): IssueTransitionsContract {
  return {
    async removeBlocked(issueNumber: number): Promise<void> {
      await deps.removeLabel(issueNumber, labels.blocked);
    },
    async addReadyForAgent(issueNumber: number): Promise<void> {
      const issue = await deps.fetchIssue(issueNumber);
      if (!issue.labels.includes(labels.readyForAgent)) {
        await deps.addLabels(issueNumber, [labels.readyForAgent]);
      }
    },
    async moveToNeedsTriage(issueNumber: number): Promise<void> {
      if (deps.updateLabels) {
        await deps.updateLabels(
          issueNumber,
          [labels.blocked, labels.readyForAgent],
          [labels.needsTriage]
        );
      } else {
        await deps.removeLabel(issueNumber, labels.blocked);
        const issue = await deps.fetchIssue(issueNumber);
        if (issue.labels.includes(labels.readyForAgent)) {
          await deps.removeLabel(issueNumber, labels.readyForAgent);
        }
        await deps.addLabels(issueNumber, [labels.needsTriage]);
      }
    },
    async moveToReadyForHuman(issueNumber: number): Promise<void> {
      try {
        await deps.removeLabel(issueNumber, labels.agentInProgress);
      } catch {
        // Ignore - label may not exist
      }
      try {
        await deps.removeLabel(issueNumber, labels.readyForAgent);
      } catch {
        // Ignore - label may not exist
      }
      await deps.addLabels(issueNumber, [labels.readyForHuman]);
    },
    async closeCompleted(issueNumber: number): Promise<void> {
      try {
        await deps.removeLabel(issueNumber, labels.agentInProgress);
      } catch {
        // Ignore - label may not exist
      }
      try {
        await deps.removeLabel(issueNumber, labels.prOpenAwaitingMerge);
      } catch {
        // Ignore - label may not exist
      }
      if (!deps.closeIssue) {
        throw new Error("closeIssue is required for closeCompleted");
      }
      await deps.closeIssue(issueNumber);
    },
  };
}

import { describe, it, expect } from "vitest";
import {
  makeFailureE2EConfig,
  makeE2EConfig,
  resolveProfile,
} from "./run-live-e2e";
import type { PourkitConfig } from "../shared/config";

function createBaseConfig(): PourkitConfig {
  return {
    targets: [
      {
        name: "e2e",
        baseBranch: "main",
        branchTemplate: "agent/{{issue.number}}",
        strategy: {
          type: "review-refactor-loop",
          implement: {
            builder: {
              agent: "test-agent",
              model: "test-model",
              promptTemplate: "test-prompt",
            },
          },
          review: {
            reviewer: {
              agent: "reviewer",
              model: "test-reviewer",
              promptTemplate: "reviewer-prompt",
              criteria: ["correctness"],
            },
            refactor: {
              agent: "refactorer",
              model: "test-refactorer",
              promptTemplate: "refactorer-prompt",
            },
            maxIterations: 3,
            passWithNotesRefactorAttempts: 2,
          },
          verify: {
            commands: [
              { command: "npm run typecheck", label: "typecheck" },
              { command: "npm run test", label: "tests" },
            ],
          },
          finalize: {
            prDescriptionAgent: {
              agent: "finalizer",
              model: "test-finalizer",
              promptTemplate: "finalizer-prompt",
            },
            maxAttempts: 2,
          },
        },
      },
    ],
    labels: {
      readyForAgent: "ready-for-agent",
      agentInProgress: "agent-in-progress",
      blocked: "blocked",
      prOpenAwaitingMerge: "pr-open-awaiting-merge",
      readyForHuman: "ready-for-human",
      needsTriage: "needs-triage",
    },

    sandbox: {
      provider: "test",
    },
    checks: {
      requiredLabels: ["ready-for-agent"],
      allowedAuthors: ["test"],
      checksFoundTimeoutSeconds: 60,
      checksCompletionTimeoutSeconds: 300,
      pollIntervalSeconds: 10,
      issueListLimit: 50,
    },
    cleanup: {
      enabled: true,
      worktreeRetentionDays: 14,
      logRetentionDays: 30,
    },
  };
}

function commands(config: PourkitConfig) {
  return config.targets[0].strategy?.verify?.commands ?? [];
}

describe("failure-mode with profile selection", () => {
  const baseConfig = createBaseConfig();

  describe("makeFailureE2EConfig preserves failure injection", () => {
    it("prepends exit 1 when fast profile is selected", () => {
      expect(baseConfig.targets[0]).not.toHaveProperty("verificationCommands");
      const profile = resolveProfile(false);
      const config = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );

      expect(commands(config)[0].command).toBe("exit 1");
      expect(commands(config)[0].label).toBe("fail-e2e");
    });

    it("prepends exit 1 when full-check profile is selected", () => {
      const profile = resolveProfile(true);
      const config = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );

      expect(commands(config)[0].command).toBe("exit 1");
      expect(commands(config)[0].label).toBe("fail-e2e");
    });

    it("keeps profile commands after exit 1 in full-check mode", () => {
      const profile = resolveProfile(true);
      const config = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );

      const verificationCommands = commands(config);
      expect(verificationCommands.length).toBe(5);
      expect(verificationCommands[1].label).toBe("prettier:check");
      expect(verificationCommands[2].label).toBe("typecheck");
      expect(verificationCommands[3].label).toBe("tests");
      expect(verificationCommands[4].label).toBe("build");
    });

    it("keeps base commands after exit 1 in fast mode", () => {
      const profile = resolveProfile(false);
      const config = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );

      const verificationCommands = commands(config);
      expect(verificationCommands.length).toBe(3);
      expect(verificationCommands[1].label).toBe("typecheck");
      expect(verificationCommands[2].label).toBe("tests");
    });
  });

  describe("failure injection wins over profile selection", () => {
    it("failure mode always has exit 1 as first command regardless of profile", () => {
      for (const fullCheck of [false, true]) {
        const profile = resolveProfile(fullCheck);
        const config = makeFailureE2EConfig(
          baseConfig,
          "e2e",
          "test-branch",
          profile
        );

        const firstCmd = commands(config)[0];
        expect(firstCmd.command).toBe("exit 1");
        expect(firstCmd.label).toBe("fail-e2e");
      }
    });

    it("success mode never has exit 1 as first command", () => {
      for (const fullCheck of [false, true]) {
        const profile = resolveProfile(fullCheck);
        const config = makeE2EConfig(baseConfig, "e2e", "test-branch", profile);

        const firstCmd = commands(config)[0];
        expect(firstCmd.command).not.toBe("exit 1");
        expect(firstCmd.label).not.toBe("fail-e2e");
      }
    });

    it("failure mode config has more commands than success mode in fast profile", () => {
      const profile = resolveProfile(false);
      const failureConfig = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );
      const successConfig = makeE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );

      expect(commands(failureConfig).length).toBe(
        commands(successConfig).length + 1
      );
    });

    it("failure mode config has more commands than success mode in full-check profile", () => {
      const profile = resolveProfile(true);
      const failureConfig = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );
      const successConfig = makeE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );

      expect(commands(failureConfig).length).toBe(
        commands(successConfig).length + 1
      );
    });
  });

  describe("deterministic failure behavior", () => {
    it("produces identical failure configs across calls with same profile", () => {
      const profile = resolveProfile(true);
      const first = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );
      const second = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch",
        profile
      );

      expect(commands(first)).toEqual(commands(second));
    });

    it("failure mode sets correct target branch", () => {
      const profile = resolveProfile(true);
      const config = makeFailureE2EConfig(
        baseConfig,
        "e2e",
        "test-branch-123",
        profile
      );

      expect(config.targets[0].baseBranch).toBe("test-branch-123");
    });

    it("does not mutate base config verification commands", () => {
      const originalCommands = [...commands(baseConfig)];
      const profile = resolveProfile(true);

      makeFailureE2EConfig(baseConfig, "e2e", "test-branch", profile);
      makeE2EConfig(baseConfig, "e2e", "test-branch", profile);

      expect(commands(baseConfig)).toEqual(originalCommands);
    });
  });
});

import { definePourkitConfig } from "./pourkit/shared/config";

export default definePourkitConfig({
  targets: [
    {
      name: "default",
      baseBranch: "next",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      autoMerge: true,
      // queue: { loop: true }, // enable queue loop mode (also via --loop CLI flag)
      setupCommands: [{ command: "npm install", label: "install" }],
      strategy: {
        type: "review-refactor-loop",
        implement: {
          builder: {
            agent: "pourkit-builder",
            model: "opencode-go/deepseek-v4-flash",
            promptTemplate: ".pourkit/prompts/builder.prompt.md",
          },
        },
        review: {
          reviewer: {
            agent: "pourkit-reviewer",
            model: "opencode-go/deepseek-v4-pro",
            promptTemplate: ".pourkit/prompts/reviewer.prompt.md",
            criteria: ["correctness", "scope", "tests", "quality"],
          },
          refactor: {
            agent: "pourkit-refactor",
            model: "opencode-go/qwen3.6-plus",
            promptTemplate: ".pourkit/prompts/refactor.prompt.md",
          },
          maxIterations: 3,
          passWithNotesRefactorAttempts: 2,
        },
        verify: {
          commands: [
            { command: "npm run typecheck", label: "typecheck" },
            { command: "npm run test:agent -- --run", label: "tests" },
            { command: "npm run prettier:check", label: "prettier" },
          ],
        },
        finalize: {
          prDescriptionAgent: {
            agent: "pourkit-pr-description",
            model: "opencode-go/deepseek-v4-flash",
            promptTemplate: ".pourkit/prompts/pr-description.prompt.md",
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
    provider: "docker",
    copyToWorktree: ["node_modules"],
    mounts: [
      {
        hostPath: "~/.local/share/opencode",
        sandboxPath: "/home/agent/.local/share/opencode",
        readonly: false,
      },
      {
        hostPath: "~/.config/opencode",
        sandboxPath: "/home/agent/.config/opencode",
        readonly: true,
      },
    ],
    env: {
      HOME: "/home/agent",
      XDG_DATA_HOME: "/home/agent/.local/share",
      XDG_CONFIG_HOME: "/home/agent/.config",
      XDG_STATE_HOME: "/home/agent/.local/state",
    },
    idleTimeoutSeconds: 300,
  },
  checks: {
    requiredLabels: [],
    allowedAuthors: [],
    checksFoundTimeoutSeconds: 60,
    checksCompletionTimeoutSeconds: 1800,
    pollIntervalSeconds: 15,
    issueListLimit: 50,
  },
  // vera: { enabled: true }, // opt-in to Vera Integration (shared .vera/ index)
});

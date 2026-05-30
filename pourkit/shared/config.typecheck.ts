import { definePourkitConfig } from "./config";
import type { PourkitConfigInput } from "./config";

const agent = {
  agent: "build",
  model: "opencode-go/deepseek-v4-flash",
  promptTemplate: "agent.prompt.md",
};

const reviewer = {
  ...agent,
  criteria: ["correctness"],
};

const validConfig = {
  targets: [
    {
      name: "default",
      strategy: {
        type: "review-refactor-loop",
        implement: { builder: agent },
        review: {
          reviewer,
          refactor: agent,
          maxIterations: 3,
        },
        verify: { commands: [{ command: "npm test" }] },
        finalize: { prDescriptionAgent: agent, maxAttempts: 2 },
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
  sandbox: { provider: "docker" },
  checks: { requiredLabels: [], allowedAuthors: [] },
  serena: {
    enabled: false,
    required: false,
    mcpUrl: "http://localhost:9121/mcp",
    sandboxMcpUrl: "http://localhost:9121/mcp",
    dataDir: ".pourkit/serena/",
    autoStart: false,
  },
} satisfies PourkitConfigInput;

definePourkitConfig(validConfig);

definePourkitConfig({
  ...validConfig,
  // @ts-expect-error unknown top-level config keys should be rejected.
  builder: agent,
});

definePourkitConfig({
  ...validConfig,
  targets: [
    {
      ...validConfig.targets[0],
      // @ts-expect-error builder is not a field on TargetInput.
      builder: agent,
    },
  ],
});

definePourkitConfig({
  ...validConfig,
  targets: [
    {
      ...validConfig.targets[0],
      strategy: {
        ...validConfig.targets[0].strategy,
        // @ts-expect-error strategy type is a fixed discriminator.
        type: "other",
      },
    },
  ],
});

// @ts-expect-error labels are required.
definePourkitConfig({
  targets: validConfig.targets,
  sandbox: validConfig.sandbox,
  checks: validConfig.checks,
});

definePourkitConfig({
  ...validConfig,
  targets: [
    {
      ...validConfig.targets[0],
      strategy: {
        ...validConfig.targets[0].strategy,
        verify: {
          commands: [
            // @ts-expect-error command must be a string.
            { command: 123 },
          ],
        },
      },
    },
  ],
});

definePourkitConfig({
  ...validConfig,
  targets: [
    {
      ...validConfig.targets[0],
      serena: {
        enabled: true,
        required: false,
      },
      strategy: {
        ...validConfig.targets[0].strategy,
        conflictResolution: {
          agent: "resolver",
          model: "test-model",
          promptTemplate: "conflict-resolution.md",
          maxAttempts: 2,
        },
      },
    },
  ],
});

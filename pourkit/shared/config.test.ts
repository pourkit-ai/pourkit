import { describe, expect, it } from "vitest";
import {
  loadConfig,
  loadRepoConfig,
  parseConfig,
  resolvePromptTemplatePath,
  resolveTarget,
  type PourkitConfig,
  type ReviewRefactorLoopStrategy,
} from "./config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const builder = {
  agent: "build",
  model: "opencode-go/deepseek-v4-flash",
  promptTemplate: "builder.prompt.md",
};

const reviewer = {
  agent: "review",
  model: "opencode-go/claude-sonnet-4",
  promptTemplate: "reviewer.prompt.md",
  criteria: ["correctness", "quality"],
};

const refactor = {
  agent: "refactor",
  model: "opencode-go/qwen3.6-plus",
  promptTemplate: "refactor.prompt.md",
};

const finalizer = {
  agent: "finalizer",
  model: "opencode-go/deepseek-v4-flash",
  promptTemplate: "finalizer.prompt.md",
};

function strategy(
  overrides: Partial<ReviewRefactorLoopStrategy> = {}
): ReviewRefactorLoopStrategy {
  return {
    type: "review-refactor-loop",
    implement: { builder },
    review: {
      reviewer,
      refactor,
      maxIterations: 3,
      passWithNotesRefactorAttempts: 2,
    },
    verify: {
      commands: [{ command: "npm run typecheck", label: "typecheck" }],
    },
    finalize: { prDescriptionAgent: finalizer, maxAttempts: 2 },
    ...overrides,
  };
}

function rawConfig(overrides: Record<string, unknown> = {}) {
  return {
    targets: [
      {
        name: "test",
        baseBranch: "main",
        branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
        strategy: strategy(),
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
    checks: {
      requiredLabels: [],
      allowedAuthors: [],
      checksFoundTimeoutSeconds: 60,
      checksCompletionTimeoutSeconds: 1800,
      pollIntervalSeconds: 15,
      issueListLimit: 50,
    },
    ...overrides,
  };
}

describe("parseConfig", () => {
  it("parses canonical review-refactor-loop strategy", () => {
    const config = parseConfig(rawConfig());
    const target = config.targets[0];

    expect(target.name).toBe("test");
    expect(target.baseBranch).toBe("main");
    expect(target.branchTemplate).toBe(
      "pourkit/{{issue.number}}/{{issue.slug}}"
    );
    expect(target.autoMerge).toBe(true);
    expect(target.strategy.implement.builder).toEqual(builder);
    expect(target.strategy.implement.builder.promptTemplate).toBe(
      "builder.prompt.md"
    );
    expect(target.strategy.review.reviewer.criteria).toEqual([
      "correctness",
      "quality",
    ]);
    expect(target.strategy.review.refactor).toEqual(refactor);
    expect(target.strategy.review.maxIterations).toBe(3);
    expect(target.strategy.verify?.commands).toEqual([
      { command: "npm run typecheck", label: "typecheck" },
    ]);
    expect(target.strategy.finalize.prDescriptionAgent).toEqual(finalizer);
    expect(config.sandbox.copyToWorktree).toBeUndefined();
  });

  it("parses sandbox copyToWorktree entries", () => {
    const config = parseConfig(
      rawConfig({
        sandbox: {
          provider: "docker",
          copyToWorktree: ["node_modules", ".env"],
        },
      })
    );

    expect(config.sandbox.copyToWorktree).toEqual(["node_modules", ".env"]);
  });

  it("parses strategy with conflictResolution section", () => {
    const config = parseConfig(
      rawConfig({
        targets: [
          {
            name: "test",
            strategy: {
              ...strategy(),
              conflictResolution: {
                agent: "resolver",
                model: "test-model",
                promptTemplate: "conflict-resolution.md",
                maxAttempts: 2,
              },
            },
          },
        ],
      })
    );
    expect(config.targets[0].strategy.conflictResolution).toMatchObject({
      agent: "resolver",
      model: "test-model",
      promptTemplate: "conflict-resolution.md",
      maxAttempts: 2,
    });
  });

  it("rejects conflictResolution with zero maxAttempts", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                conflictResolution: {
                  agent: "resolver",
                  model: "test-model",
                  promptTemplate: "conflict-resolution.md",
                  maxAttempts: 0,
                },
              },
            },
          ],
        })
      )
    ).toThrow("conflictResolution.maxAttempts");
  });

  it("rejects conflictResolution with negative maxAttempts", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                conflictResolution: {
                  agent: "resolver",
                  model: "test-model",
                  promptTemplate: "conflict-resolution.md",
                  maxAttempts: -1,
                },
              },
            },
          ],
        })
      )
    ).toThrow("conflictResolution.maxAttempts");
  });

  it("rejects conflictResolution with non-integer maxAttempts", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                conflictResolution: {
                  agent: "resolver",
                  model: "test-model",
                  promptTemplate: "conflict-resolution.md",
                  maxAttempts: 1.5,
                },
              },
            },
          ],
        })
      )
    ).toThrow(
      "targets[0].strategy.conflictResolution.maxAttempts must be an integer"
    );
  });

  it("rejects conflictResolution with missing maxAttempts", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                conflictResolution: {
                  agent: "resolver",
                  model: "test-model",
                  promptTemplate: "conflict-resolution.md",
                } as any,
              },
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.conflictResolution.maxAttempts");
  });

  it("rejects conflictResolution with unknown keys", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                conflictResolution: {
                  agent: "resolver",
                  model: "test-model",
                  promptTemplate: "conflict-resolution.md",
                  maxAttempts: 2,
                  extraKey: true,
                },
              },
            },
          ],
        })
      )
    ).toThrow(
      "targets[0].strategy.conflictResolution.extraKey is not supported"
    );
  });

  it("parsed config omits legacy mirrored fields", () => {
    const config = parseConfig(rawConfig());
    expect(config).not.toHaveProperty("builder");
    expect(config).not.toHaveProperty("maxReviewIterations");
    expect(config.targets[0]).not.toHaveProperty("verificationCommands");
    expect(config.targets[0].strategy.implement.builder).toEqual(builder);
  });

  it("parses target defaults and optional target fields", () => {
    const config = parseConfig(
      rawConfig({
        targets: [
          {
            name: "prod",
            autoMerge: false,
            setupCommands: [{ command: "npm install", label: "install" }],
            strategy: strategy({ verify: undefined }),
          },
        ],
      })
    );
    const target = config.targets[0];

    expect(target.baseBranch).toBe("main");
    expect(target.branchTemplate).toBe(
      "pourkit/{{issue.number}}/{{issue.slug}}"
    );
    expect(target.autoMerge).toBe(false);
    expect(target.setupCommands).toEqual([
      { command: "npm install", label: "install" },
    ]);
  });

  it("rejects verify config without commands", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "regression",
              strategy: strategy({ verify: {} as any }),
            },
          ],
        })
      )
    ).toThrow(
      "targets[0].strategy.verify.commands must contain at least one command"
    );
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "regression",
              strategy: strategy({ verify: { commands: [] } }),
            },
          ],
        })
      )
    ).toThrow(
      "targets[0].strategy.verify.commands must contain at least one command"
    );
  });

  it("parses queue config with loop enabled", () => {
    const config = parseConfig(
      rawConfig({
        targets: [
          {
            name: "loop-target",
            queue: { loop: true },
            strategy: strategy(),
          },
        ],
      })
    );
    const target = config.targets[0];
    expect(target.queue).toEqual({ loop: true });
  });

  it("allows target without queue config", () => {
    const config = parseConfig(rawConfig());
    expect(config.targets[0].queue).toBeUndefined();
  });

  it("rejects removed top-level config fields with migration guidance", () => {
    expect(() => parseConfig(rawConfig({ implementor: builder }))).toThrow(
      "config.implementor has been removed; use targets[].strategy.implement.builder"
    );
    expect(() => parseConfig(rawConfig({ reviewer: builder }))).toThrow(
      "config.reviewer has been removed; use targets[].strategy.review.reviewer"
    );
    expect(() => parseConfig(rawConfig({ refactorer: builder }))).toThrow(
      "config.refactorer has been removed; use targets[].strategy.review.refactor"
    );
    expect(() => parseConfig(rawConfig({ finalizer: builder }))).toThrow(
      "config.finalizer has been removed; use targets[].strategy.finalize.prDescriptionAgent"
    );
    expect(() => parseConfig(rawConfig({ maxReviewIterations: 3 }))).toThrow(
      "config.maxReviewIterations has been removed; use targets[].strategy.review.maxIterations"
    );
    expect(() => parseConfig(rawConfig({ builder }))).toThrow(
      "config.builder has been removed; use targets[].strategy.implement.builder"
    );
  });

  it("rejects removed target fields with migration guidance", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            { name: "test", strategy: strategy(), verificationCommands: [] },
          ],
        })
      )
    ).toThrow(
      "targets[0].verificationCommands has been removed; use targets[].strategy.verify.commands"
    );
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            { name: "test", strategy: strategy(), implementor: builder },
          ],
        })
      )
    ).toThrow(
      "targets[0].implementor has been removed; use targets[].strategy.implement.builder"
    );
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [{ name: "test", strategy: strategy(), reviewer: builder }],
        })
      )
    ).toThrow(
      "targets[0].reviewer has been removed; use targets[].strategy.review.reviewer"
    );
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            { name: "test", strategy: strategy(), refactorer: builder },
          ],
        })
      )
    ).toThrow(
      "targets[0].refactorer has been removed; use targets[].strategy.review.refactor"
    );
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [{ name: "test", strategy: strategy(), finalizer: builder }],
        })
      )
    ).toThrow(
      "targets[0].finalizer has been removed; use targets[].strategy.finalize.prDescriptionAgent"
    );
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            { name: "test", strategy: strategy(), maxReviewIterations: 3 },
          ],
        })
      )
    ).toThrow(
      "targets[0].maxReviewIterations has been removed; use targets[].strategy.review.maxIterations"
    );
  });

  it("rejects unknown target fields", () => {
    expect(() =>
      parseConfig(
        rawConfig({ targets: [{ name: "test", prBodyTemplate: "x" }] })
      )
    ).toThrow("targets[0].prBodyTemplate is not supported");
  });

  it("validates required sections and values", () => {
    expect(() => parseConfig({})).toThrow("at least one target");
    expect(() => parseConfig({ targets: [] })).toThrow("at least one target");
    expect(() => parseConfig(rawConfig({ targets: [{ name: "" }] }))).toThrow(
      "non-empty name"
    );
    expect(() =>
      parseConfig({ targets: [{ name: "test", strategy: strategy() }] })
    ).toThrow("labels must be an object");
    expect(() =>
      parseConfig(
        rawConfig({
          labels: {
            readyForAgent: "",
            agentInProgress: "agent-in-progress",
            blocked: "blocked",
            prOpenAwaitingMerge: "pr-open-awaiting-merge",
            readyForHuman: "ready-for-human",
          },
        })
      )
    ).toThrow("labels.readyForAgent must be a non-empty string");
    expect(() =>
      parseConfig(
        rawConfig({ checks: { requiredLabels: [""], allowedAuthors: [] } })
      )
    ).toThrow("checks.requiredLabels[0] must be a non-empty string");
  });

  it("accepts config without labels.needsTriage using default", () => {
    const raw = rawConfig();
    delete (raw.labels as Record<string, unknown>).needsTriage;
    const config = parseConfig(raw);
    expect(config.labels.needsTriage).toBe("needs-triage");
  });

  it("validates canonical strategy shape", () => {
    expect(() =>
      parseConfig(rawConfig({ targets: [{ name: "test" }] }))
    ).toThrow("targets[0].strategy must be an object");
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            { name: "test", strategy: { ...strategy(), type: "other" } },
          ],
        })
      )
    ).toThrow("targets[0].strategy.type must be review-refactor-loop");
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                verify: { commands: [{ command: "" }] },
              },
            },
          ],
        })
      )
    ).toThrow(
      "targets[0].strategy.verify.commands[0] must have a non-empty command"
    );
  });

  it("parses sandbox and check defaults", () => {
    const config = parseConfig(
      rawConfig({
        sandbox: {
          provider: "podman",
          mounts: [
            {
              hostPath: "~/.config/opencode",
              sandboxPath: "/home/agent/.config/opencode",
            },
          ],
          env: { HOME: "/home/agent" },
        },
        checks: { requiredLabels: ["ready"], allowedAuthors: ["ghost"] },
      })
    );

    expect(config.sandbox).toEqual({
      provider: "podman",
      mounts: [
        {
          hostPath: "~/.config/opencode",
          sandboxPath: "/home/agent/.config/opencode",
          readonly: false,
        },
      ],
      env: { HOME: "/home/agent" },
      idleTimeoutSeconds: undefined,
    });
    expect(config.checks.checksFoundTimeoutSeconds).toBe(60);
    expect(config.checks.checksCompletionTimeoutSeconds).toBe(30 * 60);
    expect(config.checks.pollIntervalSeconds).toBe(15);
    expect(config.checks.issueListLimit).toBe(50);
  });

  it("rejects removed checks timeoutSeconds", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          checks: {
            requiredLabels: [],
            allowedAuthors: [],
            timeoutSeconds: 120,
            pollIntervalSeconds: 15,
            issueListLimit: 50,
          },
        })
      )
    ).toThrow(
      "checks.timeoutSeconds has been removed; use checks.checksCompletionTimeoutSeconds"
    );
  });

  it("validates tightened numeric and verify rules", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: strategy({
                verify: { commands: [] },
              }),
            },
          ],
        })
      )
    ).toThrow(
      "targets[0].strategy.verify.commands must contain at least one command"
    );

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: strategy({
                review: { ...strategy().review, maxIterations: 2.5 } as any,
              }),
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.review.maxIterations must be an integer");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: strategy({
                finalize: { ...strategy().finalize, maxAttempts: 1.5 } as any,
              }),
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.finalize.maxAttempts must be an integer");

    const config = parseConfig(
      rawConfig({
        targets: [
          {
            name: "test",
            strategy: strategy({
              review: {
                ...strategy().review,
                passWithNotesRefactorAttempts: 0,
              },
            }),
          },
        ],
      })
    );
    expect(
      config.targets[0].strategy?.review.passWithNotesRefactorAttempts
    ).toBe(0);
  });

  it("rejects invalid checks numeric values", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          checks: {
            requiredLabels: [],
            allowedAuthors: [],
            pollIntervalSeconds: 0,
          },
        })
      )
    ).toThrow();

    expect(() =>
      parseConfig(
        rawConfig({
          checks: {
            requiredLabels: [],
            allowedAuthors: [],
            checksFoundTimeoutSeconds: -5,
          },
        })
      )
    ).toThrow();

    expect(() =>
      parseConfig(
        rawConfig({
          checks: {
            requiredLabels: [],
            allowedAuthors: [],
            issueListLimit: 1.5,
          },
        })
      )
    ).toThrow();
  });

  it("accepts reviewer-level passWithNotesRefactorAttempts: 0", () => {
    const config = parseConfig(
      rawConfig({
        targets: [
          {
            name: "test",
            strategy: strategy({
              review: {
                ...strategy().review,
                reviewer: {
                  ...strategy().review.reviewer,
                  passWithNotesRefactorAttempts: 0,
                },
              },
            }),
          },
        ],
      })
    );
    expect(
      config.targets[0].strategy?.review.reviewer.passWithNotesRefactorAttempts
    ).toBe(0);

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: strategy({
                review: {
                  ...strategy().review,
                  reviewer: {
                    ...strategy().review.reviewer,
                    passWithNotesRefactorAttempts: -1,
                  },
                },
              }),
            },
          ],
        })
      )
    ).toThrow();
  });

  it("validates sandbox entries", () => {
    expect(() =>
      parseConfig(
        rawConfig({ sandbox: { provider: "docker", mounts: [null] } })
      )
    ).toThrow("sandbox.mounts[0] must be an object");
    expect(() =>
      parseConfig(
        rawConfig({ sandbox: { provider: "docker", env: { HOME: 123 } } })
      )
    ).toThrow("sandbox.env.HOME must be a string");
    expect(() =>
      parseConfig(
        rawConfig({ sandbox: { provider: "docker", idleTimeoutSeconds: 0 } })
      )
    ).toThrow("sandbox.idleTimeoutSeconds must be a positive number");
    expect(() =>
      parseConfig(
        rawConfig({ sandbox: { provider: "docker", idleTimeoutSeconds: -1 } })
      )
    ).toThrow("sandbox.idleTimeoutSeconds must be a positive number");
    expect(() =>
      parseConfig(
        rawConfig({ sandbox: { provider: "docker", idleTimeoutSeconds: 1.5 } })
      )
    ).toThrow("must be an integer");
    expect(() =>
      parseConfig(
        rawConfig({
          sandbox: { provider: "docker", idleTimeoutSeconds: "abc" },
        })
      )
    ).toThrow("sandbox.idleTimeoutSeconds must be a number");
  });

  it("rejects unknown keys at every config level", () => {
    expect(() =>
      parseConfig(
        rawConfig({
          labels: {
            readyForAgent: "ready-for-agent",
            agentInProgress: "agent-in-progress",
            blocked: "blocked",
            prOpenAwaitingMerge: "pr-open-awaiting-merge",
            readyForHuman: "ready-for-human",
            needsTriage: "needs-triage",
            extra: true,
          },
        })
      )
    ).toThrow("labels.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          checks: {
            requiredLabels: [],
            allowedAuthors: [],
            extra: true,
          },
        })
      )
    ).toThrow("checks.extra is not supported");

    expect(() =>
      parseConfig(rawConfig({ sandbox: { provider: "docker", extra: true } }))
    ).toThrow("sandbox.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                implement: { builder: { ...builder, extra: true } },
              },
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.implement.builder.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                verify: { commands: [{ command: "test" }], extra: true },
              },
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.verify.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              queue: { loop: true, extra: true },
              strategy: strategy(),
            },
          ],
        })
      )
    ).toThrow("targets[0].queue.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              setupCommands: [
                { command: "npm test", label: "test", extra: true },
              ],
              strategy: strategy(),
            },
          ],
        })
      )
    ).toThrow("targets[0].setupCommands[0].extra is not supported");

    expect(() => parseConfig(rawConfig({ extra: true }))).toThrow(
      "extra is not supported"
    );

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [{ name: "test", strategy: strategy(), extra: true }],
        })
      )
    ).toThrow("targets[0].extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [{ name: "test", strategy: { ...strategy(), extra: true } }],
        })
      )
    ).toThrow("targets[0].strategy.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                review: { ...strategy().review, extra: true },
              },
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.review.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                finalize: { ...strategy().finalize, extra: true },
              },
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.finalize.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          targets: [
            {
              name: "test",
              strategy: {
                ...strategy(),
                review: {
                  ...strategy().review,
                  reviewer: { ...strategy().review.reviewer, extra: true },
                },
              },
            },
          ],
        })
      )
    ).toThrow("targets[0].strategy.review.reviewer.extra is not supported");

    expect(() =>
      parseConfig(
        rawConfig({
          sandbox: {
            provider: "docker",
            mounts: [{ hostPath: "/a", sandboxPath: "/b", extra: true }],
          },
        })
      )
    ).toThrow("sandbox.mounts[0].extra is not supported");
  });

  it("keeps sandbox.env passthrough while schemas are strict", () => {
    const config = parseConfig(
      rawConfig({
        sandbox: {
          provider: "docker",
          env: { HOME: "/home/agent", CUSTOM_FLAG: "1" },
        },
      })
    );
    expect(config.sandbox.env).toEqual({
      HOME: "/home/agent",
      CUSTOM_FLAG: "1",
    });
  });

  it("allows empty canonical arrays", () => {
    const config = parseConfig(
      rawConfig({
        targets: [
          {
            name: "test",
            setupCommands: [],
            strategy: strategy(),
          },
        ],
        checks: {
          requiredLabels: [],
          allowedAuthors: [],
        },
      })
    );
    expect(config.targets[0].setupCommands).toEqual([]);
    expect(config.checks.requiredLabels).toEqual([]);
    expect(config.checks.allowedAuthors).toEqual([]);
  });
});

describe("resolvePromptTemplatePath", () => {
  it("resolves bare filenames under .pourkit/prompts", () => {
    const result = resolvePromptTemplatePath("/repo", "builder.prompt.md");
    expect(result).toBe("/repo/.pourkit/prompts/builder.prompt.md");
  });

  it("resolves explicit .pourkit paths from repo root", () => {
    const result = resolvePromptTemplatePath(
      "/repo",
      ".pourkit/prompts/builder.prompt.md"
    );
    expect(result).toBe("/repo/.pourkit/prompts/builder.prompt.md");
  });

  it("resolves non-.pourkit repo-relative paths from repo root", () => {
    const result = resolvePromptTemplatePath(
      "/repo",
      "custom-prompts/builder.prompt.md"
    );
    expect(result).toBe("/repo/custom-prompts/builder.prompt.md");
  });
});

describe("resolveTarget", () => {
  const makeConfig = (targets: Record<string, unknown>[]): PourkitConfig =>
    parseConfig(rawConfig({ targets }));

  const makeTarget = (name: string, baseBranch = "main") => ({
    name,
    baseBranch,
    branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
    strategy: strategy(),
  });

  it("returns single target without explicit name", () => {
    expect(resolveTarget(makeConfig([makeTarget("solo")]))).toMatchObject({
      name: "solo",
    });
  });

  it("requires --target when multiple targets exist", () => {
    expect(() =>
      resolveTarget(makeConfig([makeTarget("a"), makeTarget("b")]))
    ).toThrow("Multiple targets");
  });

  it("returns explicit target when specified", () => {
    expect(
      resolveTarget(
        makeConfig([makeTarget("a"), makeTarget("b", "develop")]),
        "b"
      )
    ).toMatchObject({ name: "b", baseBranch: "develop" });
  });

  it("throws for unknown target name", () => {
    expect(() =>
      resolveTarget(makeConfig([makeTarget("a"), makeTarget("b")]), "x")
    ).toThrow("not found");
  });
});

describe("loadConfig", () => {
  const minimalJsonConfig = JSON.stringify(rawConfig());

  it("loads a .json config file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pourkit-config-test-"));
    const configPath = path.join(dir, "pourkit.json");
    await writeFile(configPath, minimalJsonConfig, "utf-8");

    try {
      const config = await loadConfig(configPath);
      expect(config.targets[0].name).toBe("test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a .mjs config file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pourkit-config-test-"));
    const configPath = path.join(dir, "pourkit.mjs");
    await writeFile(
      configPath,
      `export default ${minimalJsonConfig};`,
      "utf-8"
    );

    try {
      const config = await loadConfig(configPath);
      expect(config.targets[0].name).toBe("test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported extensions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pourkit-config-test-"));
    const configPath = path.join(dir, "pourkit.yaml");
    await writeFile(configPath, "targets: []", "utf-8");

    try {
      await expect(loadConfig(configPath)).rejects.toThrow(
        "Unsupported config format: yaml"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadRepoConfig", () => {
  it("loads the repo pourkit.config.example.ts", async () => {
    const repoRoot = path.dirname(
      path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    );

    const config = await loadRepoConfig(repoRoot, "pourkit.config.example.ts");
    expect(config.targets.length).toBeGreaterThan(0);
    expect(config.labels.readyForAgent).toBe("ready-for-agent");
    expect(config.targets[0].strategy.implement.builder.agent).toBe(
      "pourkit-builder"
    );

    const promptsDir = path.join(repoRoot, ".pourkit", "prompts");
    expect(existsSync(path.join(promptsDir, "builder.prompt.md"))).toBe(true);
  });

  it("throws when config file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pourkit-config-test-"));

    try {
      await expect(loadRepoConfig(dir)).rejects.toThrow("No config file found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when config has no default export", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pourkit-config-test-"));
    await writeFile(
      path.join(dir, "pourkit.config.ts"),
      "export const foo = 1;",
      "utf-8"
    );

    try {
      await expect(loadRepoConfig(dir)).rejects.toThrow(
        "pourkit.config.ts must have a default export"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a config with imports", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pourkit-config-test-"));
    await writeFile(
      path.join(dir, "helpers.ts"),
      `export const baseBranch = "main";`,
      "utf-8"
    );
    await writeFile(
      path.join(dir, "pourkit.config.ts"),
      `import { baseBranch } from "./helpers";

export default ${JSON.stringify(rawConfig()).replace('"baseBranch":"main"', '"baseBranch":baseBranch')};`,
      "utf-8"
    );

    try {
      const config = await loadRepoConfig(dir);
      expect(config.targets[0].baseBranch).toBe("main");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("prompt vocabulary", () => {
  const promptsDir = path.resolve(
    path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
    ".pourkit",
    "prompts"
  );

  it("builder prompt uses Builder vocabulary", () => {
    const content = readFileSync(
      path.join(promptsDir, "builder.prompt.md"),
      "utf-8"
    );
    expect(content).not.toMatch(/\bimplementor\b/i);
    expect(content).toMatch(/\bBuilder\b/);
    expect(content).not.toContain("npm run build:agent");
    expect(content).toContain("Verification Commands");
    expect(content).toContain(".pourkit/.tmp/run-context.md");
    expect(content).toContain("Assumption check: pass");
    expect(content).toContain("Assumption check: mismatch");
    expect(content).toContain("Advisory Analyzer");
    expect(content).toContain("advisory-analyzer");
    expect(content).toContain("advisory only");
    expect(content).toContain("at most 3 Advisory Analyzer calls");
  });

  it("reviewer prompt uses Builder vocabulary", () => {
    const content = readFileSync(
      path.join(promptsDir, "reviewer.prompt.md"),
      "utf-8"
    );
    expect(content).not.toMatch(/\bimplementor\b/i);
    expect(content).toMatch(/\bBuilder\b/);
    expect(content).toMatch(/builder agent has already edited the worktree/);
  });

  it("refactor prompt uses Builder vocabulary", () => {
    const content = readFileSync(
      path.join(promptsDir, "refactor.prompt.md"),
      "utf-8"
    );
    expect(content).not.toMatch(/\bimplementor\b/i);
    expect(content).toMatch(/\bBuilder\b/);
    expect(content).toMatch(/Preserve valid builder work/);
    expect(content).not.toContain("npm run test:agent");
    expect(content).toContain("Verification Commands");
    expect(content).toContain(".pourkit/.tmp/run-context.md");
    expect(content).toContain("Advisory Analyzer");
    expect(content).toContain("cannot override official Reviewer output");
    expect(content).toContain("at most 3 Advisory Analyzer calls");
  });

  it("advisory analyzer prompt uses advisory tokens only", () => {
    const content = readFileSync(
      path.join(promptsDir, "advisory-analyzer.prompt.md"),
      "utf-8"
    );
    expect(content).toContain("<advisory>PASS</advisory>");
    expect(content).toContain("<advisory>FIX_RECOMMENDED</advisory>");
    expect(content).toContain("<advisory>NEEDS_HUMAN</advisory>");
    expect(content).not.toContain("<verdict>");
    expect(content).not.toContain("</verdict>");
  });
});

describe("project opencode config", () => {
  const repoRoot = path.resolve(
    path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
  );

  it("defines prefixed Pourkit primaries and hidden advisory analyzer", () => {
    const content = readFileSync(path.join(repoRoot, "opencode.json"), "utf-8");
    const config = JSON.parse(content);

    expect(config.agent["pourkit-builder"].mode).toBe("primary");
    expect(config.agent["pourkit-reviewer"].mode).toBe("primary");
    expect(config.agent["pourkit-refactor"].mode).toBe("primary");
    expect(config.agent["pourkit-pr-description"].mode).toBe("primary");
    expect(config.agent["advisory-analyzer"]).toMatchObject({
      mode: "subagent",
      hidden: true,
      prompt: "{file:.pourkit/prompts/advisory-analyzer.prompt.md}",
    });
  });

  it("limits advisory analyzer task permissions to Builder and Refactor", () => {
    const config = JSON.parse(
      readFileSync(path.join(repoRoot, "opencode.json"), "utf-8")
    );

    expect(config.agent["pourkit-builder"].permission.task).toEqual({
      "*": "deny",
      "advisory-analyzer": "allow",
    });
    expect(config.agent["pourkit-refactor"].permission.task).toEqual({
      "*": "deny",
      "advisory-analyzer": "allow",
    });
    expect(config.agent["pourkit-reviewer"].permission.task).toBe("deny");
    expect(config.agent["pourkit-pr-description"].permission.task).toBe("deny");
    expect(config.agent["advisory-analyzer"].permission).toMatchObject({
      edit: "deny",
      bash: "deny",
      task: "deny",
    });
  });
});

describe("CONTEXT.md glossary", () => {
  const contextDir = path.resolve(
    path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
    ".pourkit"
  );

  it("regression: existing glossary terms remain present", () => {
    const content = readFileSync(path.join(contextDir, "CONTEXT.md"), "utf-8");
    expect(content).toMatch(/\*\*Worktree\*\*/);
    expect(content).toMatch(/\*\*Runtime Boundary Validation\*\*/);
    expect(content).toMatch(/\*\*Conflict Resolution Agent\*\*/);
  });
});

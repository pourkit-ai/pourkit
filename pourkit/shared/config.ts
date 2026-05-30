import { join } from "node:path";
import { z } from "zod";

export interface CleanupConfig {
  enabled: boolean;
  worktreeRetentionDays: number;
  logRetentionDays: number;
}

export interface SerenaConfig {
  enabled: boolean;
  required: boolean;
  mcpUrl: string;
  sandboxMcpUrl: string;
  dataDir: string;
  autoStart: boolean;
}

export interface SerenaConfigInput {
  enabled?: boolean;
  required?: boolean;
  mcpUrl?: string;
  sandboxMcpUrl?: string;
  dataDir?: string;
  autoStart?: boolean;
}

export interface TargetSerenaConfig {
  enabled?: boolean;
  required?: boolean;
}

export interface PourkitConfig {
  targets: Target[];
  labels: LabelsConfig;
  sandbox: SandboxConfig;
  checks: ChecksConfig;
  cleanup: CleanupConfig;
  serena: SerenaConfig;
}

export interface PourkitConfigInput {
  targets: TargetInput[];
  labels: LabelsConfig;
  sandbox: SandboxConfig;
  checks: ChecksConfigInput;
  cleanup?: Partial<CleanupConfig>;
  serena?: SerenaConfigInput;
}

export interface StageAgentConfig {
  agent: string;
  model: string;
  promptTemplate: string;
}

export interface ConflictResolutionConfigInput extends StageAgentConfig {
  maxAttempts: number;
}

export interface ConflictResolutionConfig extends StageAgentConfig {
  maxAttempts: number;
}

export interface ReviewerConfig extends StageAgentConfig {
  criteria: string[];
  includeReviewHistory?: boolean;
  /** @deprecated Use strategy.review.passWithNotesRefactorAttempts. */
  passWithNotesRefactorAttempts?: number;
}

export interface BuilderConfig extends StageAgentConfig {}

export interface QueueConfig {
  loop?: boolean;
}

export interface ChecksConfigInput {
  requiredLabels: string[];
  allowedAuthors: string[];
  checksFoundTimeoutSeconds?: number;
  checksCompletionTimeoutSeconds?: number;
  pollIntervalSeconds?: number;
  issueListLimit?: number;
}

export interface TargetInput {
  name: string;
  baseBranch?: string;
  branchTemplate?: string;
  setupCommands?: VerificationCommandInput[];
  autoMerge?: boolean;
  queue?: QueueConfig;
  serena?: TargetSerenaConfig;
  strategy: ReviewRefactorLoopStrategyInput;
}

export interface Target {
  name: string;
  baseBranch: string;
  branchTemplate: string;
  setupCommands?: VerificationCommand[];
  autoMerge?: boolean;
  queue?: QueueConfig;
  serena?: TargetSerenaConfig;
  strategy: ReviewRefactorLoopStrategy;
}

export type ResolvedTarget = Target;

export type TargetStrategy = ReviewRefactorLoopStrategy;

export interface ReviewRefactorLoopStrategyInput {
  type: "review-refactor-loop";
  implement: {
    builder: StageAgentConfig;
  };
  conflictResolution?: ConflictResolutionConfigInput;
  review: {
    reviewer: ReviewerConfig;
    refactor: StageAgentConfig;
    maxIterations: number;
    passWithNotesRefactorAttempts?: number;
  };
  verify?: VerifyConfigInput;
  finalize: {
    prDescriptionAgent: StageAgentConfig;
    maxAttempts: number;
  };
}

export interface ReviewRefactorLoopStrategy {
  type: "review-refactor-loop";
  implement: {
    builder: StageAgentConfig;
  };
  conflictResolution?: ConflictResolutionConfig;
  review: {
    reviewer: ReviewerConfig;
    refactor: StageAgentConfig;
    maxIterations: number;
    passWithNotesRefactorAttempts: number;
  };
  verify?: VerifyConfig;
  finalize: {
    prDescriptionAgent: StageAgentConfig;
    maxAttempts: number;
  };
}

export interface VerifyConfig {
  commands: VerificationCommand[];
}

export interface VerifyConfigInput {
  commands?: VerificationCommandInput[];
}

export interface LabelsConfig {
  readyForAgent: string;
  agentInProgress: string;
  blocked: string;
  prOpenAwaitingMerge: string;
  readyForHuman: string;
  needsTriage: string;
}

export interface SandboxConfig {
  provider: string;
  copyToWorktree?: string[];
  mounts?: SandboxMountConfig[];
  env?: Record<string, string>;
  idleTimeoutSeconds?: number;
  forceRebuild?: boolean;
}

export interface SandboxMountConfig {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}

export interface VerificationCommand {
  command: string;
  label: string;
}

export interface VerificationCommandInput {
  command: string;
  label?: string;
}

export interface ChecksConfig {
  requiredLabels: string[];
  allowedAuthors: string[];
  checksFoundTimeoutSeconds: number;
  checksCompletionTimeoutSeconds: number;
  pollIntervalSeconds: number;
  issueListLimit: number;
}

export interface IssueData {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: string[];
  createdAt?: Date;
}

// ---- Zod schemas ----

const NonEmptyString = z.string().trim().min(1);

const StageAgentConfigSchema = z
  .object({
    agent: NonEmptyString,
    model: NonEmptyString,
    promptTemplate: NonEmptyString,
  })
  .strict();

const ReviewerConfigSchema = z
  .object({
    agent: NonEmptyString,
    model: NonEmptyString,
    promptTemplate: NonEmptyString,
    criteria: z.array(NonEmptyString),
    includeReviewHistory: z.boolean().optional(),
    passWithNotesRefactorAttempts: z.number().int().nonnegative().optional(),
  })
  .strict();

const VerificationCommandSchema = z
  .object({
    command: z.string().nullable().optional(),
    label: z.string().optional(),
  })
  .strict()
  .refine((d) => d.command && d.command.trim() !== "", {
    message: "must have a non-empty command",
  })
  .transform((d) => ({
    command: d.command!,
    label: d.label && d.label.trim() !== "" ? d.label : undefined,
  }));

const QueueConfigSchema = z
  .object({
    loop: z.boolean().optional(),
  })
  .strict();

const ReviewRefactorLoopStrategySchema = z
  .object({
    type: z.literal("review-refactor-loop"),
    implement: z
      .object({
        builder: StageAgentConfigSchema,
      })
      .strict(),
    conflictResolution: z
      .object({
        agent: NonEmptyString,
        model: NonEmptyString,
        promptTemplate: NonEmptyString,
        maxAttempts: z.number().int().positive(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        reviewer: ReviewerConfigSchema,
        refactor: StageAgentConfigSchema,
        maxIterations: z.number().int().positive(),
        passWithNotesRefactorAttempts: z
          .number()
          .int()
          .nonnegative()
          .default(2),
      })
      .strict(),
    verify: z
      .object({
        commands: z.preprocess(
          (v) => (Array.isArray(v) ? v : []),
          z.array(VerificationCommandSchema).refine((arr) => arr.length > 0, {
            message: "must contain at least one command",
          })
        ),
      })
      .strict()
      .optional(),
    finalize: z
      .object({
        prDescriptionAgent: StageAgentConfigSchema,
        maxAttempts: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const TargetSerenaConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .strict();

const TargetSchema = z
  .object({
    name: NonEmptyString,
    baseBranch: z.preprocess(
      (v) => (typeof v === "string" && v.length > 0 ? v : undefined),
      NonEmptyString.default("main")
    ),
    branchTemplate: z
      .string()
      .default("pourkit/{{issue.number}}/{{issue.slug}}"),
    setupCommands: z.preprocess(
      (v) => (Array.isArray(v) ? v : undefined),
      z.array(VerificationCommandSchema).default([])
    ),
    autoMerge: z.preprocess(
      (v) => (typeof v === "boolean" ? v : undefined),
      z.boolean().default(true)
    ),
    queue: QueueConfigSchema.optional(),
    serena: TargetSerenaConfigSchema.optional(),
    strategy: ReviewRefactorLoopStrategySchema,
  })
  .strict();

const LabelsSchema = z
  .object({
    readyForAgent: NonEmptyString,
    agentInProgress: NonEmptyString,
    blocked: NonEmptyString,
    prOpenAwaitingMerge: NonEmptyString,
    readyForHuman: NonEmptyString,
    needsTriage: NonEmptyString.optional().default("needs-triage"),
  })
  .strict();

const SandboxMountSchema = z
  .object({
    hostPath: NonEmptyString,
    sandboxPath: NonEmptyString,
    readonly: z.boolean().default(false),
  })
  .strict();

const SandboxSchema = z
  .object({
    provider: NonEmptyString,
    copyToWorktree: z.array(NonEmptyString).optional(),
    mounts: z.array(SandboxMountSchema).optional(),
    env: z.record(z.string()).optional(),
    idleTimeoutSeconds: z.preprocess((v) => {
      if (v === undefined) return undefined;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
      return v;
    }, z.number().int().positive().optional()),
  })
  .strict();

const ChecksSchema = z
  .object({
    requiredLabels: z.array(NonEmptyString),
    allowedAuthors: z.array(NonEmptyString),
    checksFoundTimeoutSeconds: z.number().int().positive().optional(),
    checksCompletionTimeoutSeconds: z.number().int().positive().optional(),
    pollIntervalSeconds: z.number().int().positive().optional(),
    issueListLimit: z.number().int().positive().optional(),
  })
  .strict();

const CleanupConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    worktreeRetentionDays: z.number().int().positive().default(14),
    logRetentionDays: z.number().int().positive().default(30),
  })
  .strict();

const SerenaConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    required: z.boolean().default(false),
    mcpUrl: NonEmptyString.default("http://localhost:9121/mcp"),
    sandboxMcpUrl: NonEmptyString.default("http://localhost:9121/mcp"),
    dataDir: z.string().default(".pourkit/serena/"),
    autoStart: z.boolean().default(false),
  })
  .strict();

const PourkitConfigSchema = z
  .object({
    targets: z.array(TargetSchema).min(1),
    labels: LabelsSchema,
    sandbox: SandboxSchema,
    checks: ChecksSchema,
    cleanup: CleanupConfigSchema.optional(),
    serena: SerenaConfigSchema.default({}),
  })
  .strict();

// ---- Removed field preflight ----

const removedFieldReplacements: Record<string, string> = {
  "config.implementor": "targets[].strategy.implement.builder",
  "config.reviewer": "targets[].strategy.review.reviewer",
  "config.refactorer": "targets[].strategy.review.refactor",
  "config.finalizer": "targets[].strategy.finalize.prDescriptionAgent",
  "config.maxReviewIterations": "targets[].strategy.review.maxIterations",
  "config.builder": "targets[].strategy.implement.builder",
  "targets[].verificationCommands": "targets[].strategy.verify.commands",
  "targets[].implementor": "targets[].strategy.implement.builder",
  "targets[].reviewer": "targets[].strategy.review.reviewer",
  "targets[].refactorer": "targets[].strategy.review.refactor",
  "targets[].finalizer": "targets[].strategy.finalize.prDescriptionAgent",
  "targets[].maxReviewIterations": "targets[].strategy.review.maxIterations",
  "checks.timeoutSeconds": "checks.checksCompletionTimeoutSeconds",
};

function checkRemovedFields(raw: Record<string, unknown>): void {
  const topLevelKeys = [
    "implementor",
    "reviewer",
    "refactorer",
    "finalizer",
    "maxReviewIterations",
    "builder",
  ];
  for (const key of topLevelKeys) {
    if (key in raw) {
      throw new Error(
        `config.${key} has been removed; use ${removedFieldReplacements[`config.${key}`]}`
      );
    }
  }

  const targetLevelKeys = [
    "verificationCommands",
    "implementor",
    "reviewer",
    "refactorer",
    "finalizer",
    "maxReviewIterations",
  ];
  if (Array.isArray(raw.targets)) {
    for (let i = 0; i < raw.targets.length; i++) {
      const t = raw.targets[i];
      if (t && typeof t === "object") {
        const target = t as Record<string, unknown>;
        for (const key of targetLevelKeys) {
          if (key in target) {
            throw new Error(
              `targets[${i}].${key} has been removed; use ${removedFieldReplacements[`targets[].${key}`]}`
            );
          }
        }
      }
    }
  }

  if (raw.checks && typeof raw.checks === "object") {
    const checks = raw.checks as Record<string, unknown>;
    if ("timeoutSeconds" in checks) {
      throw new Error(
        "checks.timeoutSeconds has been removed; use checks.checksCompletionTimeoutSeconds"
      );
    }
  }
}

// ---- Zod error formatting ----

function formatZodPath(path: (string | number)[]): string {
  if (path.length === 0) return "";
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else {
      result += result ? `.${segment}` : segment;
    }
  }
  return result;
}

function formatFirstZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  const path = formatZodPath(issue.path);

  if (
    path === "targets" &&
    (issue.code === "too_small" || issue.code === "invalid_type")
  ) {
    return "Config must have at least one target";
  }

  if (
    issue.path.length >= 3 &&
    issue.path[0] === "targets" &&
    typeof issue.path[1] === "number" &&
    issue.path[2] === "name" &&
    issue.code === z.ZodIssueCode.too_small
  ) {
    return `Target[${issue.path[1]}] must have a non-empty name`;
  }

  switch (issue.code) {
    case z.ZodIssueCode.invalid_type: {
      if (issue.expected === "object") {
        return path ? `${path} must be an object` : "Config must be an object";
      }
      if (issue.expected === "integer") {
        return `${path} must be an integer`;
      }
      if (issue.expected === "string") {
        return `${path} must be a string`;
      }
      if (issue.expected === "number") {
        return `${path} must be a number`;
      }
      return issue.message;
    }
    case z.ZodIssueCode.too_small:
      if (issue.type === "string" && issue.minimum === 1) {
        return `${path} must be a non-empty string`;
      }
      if (issue.type === "array" && issue.minimum === 1) {
        return `${path} must not be empty`;
      }
      if (issue.type === "number") {
        return `${path} must be a positive number`;
      }
      return issue.message;
    case z.ZodIssueCode.invalid_literal:
      return `${path} must be ${issue.expected}`;
    case z.ZodIssueCode.unrecognized_keys:
      const keyPath = path ? `${path}.${issue.keys[0]}` : issue.keys[0];
      return `${keyPath} is not supported`;
    case z.ZodIssueCode.custom:
      return path ? `${path} ${issue.message}` : issue.message;
    default:
      return issue.message;
  }
}

// ---- Config parsing ----

export function parseConfig(raw: unknown): PourkitConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be an object");
  }

  const config = raw as Record<string, unknown>;

  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error("Config must have at least one target");
  }

  checkRemovedFields(config);

  const rawTargets = config.targets as Record<string, unknown>[];
  for (let i = 0; i < rawTargets.length; i++) {
    const t = rawTargets[i];
    if (t === null || typeof t !== "object") {
      throw new Error(`targets[${i}] must be an object`);
    }
    assertKnownKeys(t, `targets[${i}]`, [
      "name",
      "baseBranch",
      "branchTemplate",
      "setupCommands",
      "autoMerge",
      "queue",
      "serena",
      "strategy",
    ]);
  }

  if (config.sandbox && typeof config.sandbox === "object") {
    assertKnownKeys(config.sandbox as Record<string, unknown>, "sandbox", [
      "provider",
      "copyToWorktree",
      "mounts",
      "env",
      "idleTimeoutSeconds",
    ]);
  }

  const result = PourkitConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatFirstZodError(result.error));
  }

  const data = result.data;

  const targets: Target[] = data.targets.map((t) => {
    const setupCommands = t.setupCommands?.map((cmd, i) => ({
      command: cmd.command,
      label: cmd.label ?? `check-${i}`,
    }));
    const verifyCommands = t.strategy.verify?.commands?.map((cmd, i) => ({
      command: cmd.command,
      label: cmd.label ?? `check-${i}`,
    }));
    return {
      name: t.name,
      baseBranch: t.baseBranch,
      branchTemplate: t.branchTemplate,
      setupCommands,
      autoMerge: t.autoMerge,
      queue: t.queue,
      serena: t.serena,
      strategy: {
        type: "review-refactor-loop" as const,
        implement: { builder: t.strategy.implement.builder },
        ...(t.strategy.conflictResolution
          ? {
              conflictResolution: {
                agent: t.strategy.conflictResolution.agent,
                model: t.strategy.conflictResolution.model,
                promptTemplate: t.strategy.conflictResolution.promptTemplate,
                maxAttempts: t.strategy.conflictResolution.maxAttempts,
              },
            }
          : {}),
        review: {
          reviewer: t.strategy.review.reviewer,
          refactor: t.strategy.review.refactor,
          maxIterations: t.strategy.review.maxIterations,
          passWithNotesRefactorAttempts:
            t.strategy.review.passWithNotesRefactorAttempts,
        },
        ...(t.strategy.verify ? { verify: { commands: verifyCommands! } } : {}),
        finalize: {
          prDescriptionAgent: t.strategy.finalize.prDescriptionAgent,
          maxAttempts: t.strategy.finalize.maxAttempts,
        },
      },
    };
  });

  return {
    targets,
    labels: data.labels,
    sandbox: {
      provider: data.sandbox.provider,
      copyToWorktree: data.sandbox.copyToWorktree,
      mounts: data.sandbox.mounts,
      env: data.sandbox.env,
      idleTimeoutSeconds: data.sandbox.idleTimeoutSeconds,
    },
    checks: {
      requiredLabels: data.checks.requiredLabels,
      allowedAuthors: data.checks.allowedAuthors,
      checksFoundTimeoutSeconds: data.checks.checksFoundTimeoutSeconds ?? 60,
      checksCompletionTimeoutSeconds:
        data.checks.checksCompletionTimeoutSeconds ?? 30 * 60,
      pollIntervalSeconds: data.checks.pollIntervalSeconds ?? 15,
      issueListLimit: data.checks.issueListLimit ?? 50,
    },
    serena: data.serena,
    cleanup: {
      enabled: data.cleanup?.enabled ?? true,
      worktreeRetentionDays: data.cleanup?.worktreeRetentionDays ?? 14,
      logRetentionDays: data.cleanup?.logRetentionDays ?? 30,
    },
  };
}

// ---- Key validation helpers (used before Zod for matching error format) ----

function assertKnownKeys(
  value: Record<string, unknown>,
  path: string,
  knownKeys: string[]
) {
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) {
      throw new Error(`${path}.${key} is not supported`);
    }
  }
}

// ---- Public API ----

export function definePourkitConfig(
  config: PourkitConfigInput
): PourkitConfigInput {
  return config;
}

export function getVerificationCommands(target: Target): VerificationCommand[] {
  return target.strategy.verify?.commands ?? [];
}

export async function loadRepoConfig(
  repoRoot: string,
  configFileName = "pourkit.config.ts"
): Promise<PourkitConfig> {
  const { existsSync } = await import("node:fs");
  const { readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: pjoin, basename } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { build } = await import("esbuild");

  const configPath = pjoin(repoRoot, configFileName);

  if (!existsSync(configPath)) {
    throw new Error(
      `No config file found at ${configPath}. Create a ${configFileName} that exports a default PourkitConfig.`
    );
  }

  const tmpFile = pjoin(
    tmpdir(),
    `pourkit-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`
  );

  try {
    await build({
      entryPoints: [configPath],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      external: ["node:*"],
    }).then(async (result) => {
      const output = result.outputFiles[0].text;
      await writeFile(tmpFile, output, "utf-8");
    });

    const imported = await import(pathToFileURL(tmpFile).href);
    const raw = imported.default;

    if (raw === undefined) {
      throw new Error("pourkit.config.ts must have a default export");
    }

    return parseConfig(raw);
  } finally {
    try {
      await rm(tmpFile, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function loadConfig(configPath: string): Promise<PourkitConfig> {
  const { readFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const ext = configPath.split(".").pop()?.toLowerCase();

  if (ext === "json") {
    const raw = await readFile(configPath, "utf-8");
    return parseConfig(JSON.parse(raw));
  }

  if (ext === "mjs" || ext === "js") {
    const imported = await import(pathToFileURL(configPath).href);
    const raw = imported.default ?? imported;
    return parseConfig(raw);
  }

  throw new Error(`Unsupported config format: ${ext}. Use .json, .mjs, or .js`);
}

export function resolvePromptTemplatePath(
  repoRoot: string,
  promptTemplate: string
): string {
  if (promptTemplate.includes("/")) {
    return join(repoRoot, promptTemplate);
  }
  return join(repoRoot, ".pourkit", "prompts", promptTemplate);
}

export function resolveTarget(
  config: PourkitConfig,
  explicitTarget?: string
): ResolvedTarget {
  if (config.targets.length === 0) {
    throw new Error("No targets configured");
  }

  if (config.targets.length === 1) {
    const target = config.targets[0];
    if (explicitTarget && target.name !== explicitTarget) {
      throw new Error(
        `Target "${explicitTarget}" not found. Available: ${target.name}`
      );
    }
    return target;
  }

  if (!explicitTarget) {
    throw new Error(
      `Multiple targets configured: ${config.targets.map((t) => t.name).join(", ")}. Use --target to select one.`
    );
  }

  const found = config.targets.find((t) => t.name === explicitTarget);
  if (!found) {
    throw new Error(
      `Target "${explicitTarget}" not found. Available: ${config.targets.map((t) => t.name).join(", ")}`
    );
  }

  return found;
}

import { existsSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { confirm, isCancel, log, select, text } from "@clack/prompts";
import type { GitHubClient } from "../providers/github-client";
import { tryCreateGitHubClient } from "../providers/github-client";

const execFileAsync = promisify(execFile);

export const NO_TOKEN_LABEL_PROVISIONING_WARNING =
  "Skipped GitHub label provisioning because no GitHub token was provided.";

export const ALLOWED_VERIFICATION_SCRIPTS = [
  "typecheck",
  "lint",
  "test",
  "test:agent",
  "build",
  "check",
  "prettier:check",
] as const;

export type InitOperationKind =
  | "create"
  | "update"
  | "copy"
  | "move"
  | "skip"
  | "warn"
  | "install"
  | "provision-label";

export type InitOwnership = "managed" | "project-owned" | "copied-customizable";

export interface InitOperation {
  kind: InitOperationKind;
  path?: string;
  sourcePath?: string;
  ownership?: InitOwnership;
  reason: string;
  requiresConfirmation: boolean;
  destructive: boolean;
  conflict?: string;
  content?: string;
  checksum?: string;
  labelName?: string;
  labelColor?: string;
  labelDescription?: string;
  command?: string;
  label?: string;
}

export interface InitPlan {
  targetRoot: string;
  sourceRoot: string;
  operations: InitOperation[];
  warnings: string[];
  hasLabelConflicts?: boolean;
}

export interface LocalSourceMetadata {
  versionSource: "local-git" | "local-path";
  sourceDirty: boolean;
  branch: string;
  sha: string;
  releaseChannel: string;
  latestTag: string | null;
}

export type DocsMigrationMode = "copy" | "move" | "skip";
export type AgentFileMode = "agents" | "claude" | "both" | "skip";

export interface InitConflictPolicy {
  docsMigration: DocsMigrationMode;
  agentFile: AgentFileMode;
  yes: boolean;
}

export interface InitCliOptions {
  cwd?: string;
  fromLocal?: string;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  agentFile?: AgentFileMode;
  docsMigration?: DocsMigrationMode;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  noGitCheck?: boolean;
  skipInstall?: boolean;
  legacySkills?: boolean;
}

export interface RunnerLabelsConfig {
  readyForAgent: string;
  agentInProgress: string;
  blocked: string;
  prOpenAwaitingMerge: string;
  readyForHuman: string;
}

export const DEFAULT_RUNNER_LABELS: RunnerLabelsConfig = {
  readyForAgent: "ready-for-agent",
  agentInProgress: "agent-in-progress",
  blocked: "blocked",
  prOpenAwaitingMerge: "pr-open-awaiting-merge",
  readyForHuman: "ready-for-human",
};

export interface CanonicalLabelDefinition {
  role: string;
  name: string;
  color: string;
  description: string;
  runnerManaged: boolean;
}

export type LabelConflictPolicy =
  | "keep-existing"
  | "update-to-pourkit"
  | "skip-metadata-changes";

const CANONICAL_LABEL_METADATA: Array<{
  role: string;
  color: string;
  description: string;
  runnerManaged: boolean;
}> = [
  {
    role: "ready-for-agent",
    color: "#1D76DB",
    description: "Fully specified, ready for an AFK agent",
    runnerManaged: true,
  },
  {
    role: "agent-in-progress",
    color: "#5319E7",
    description: "Agent is actively working on this issue",
    runnerManaged: true,
  },
  {
    role: "blocked",
    color: "#B60205",
    description: "Has unresolved dependencies",
    runnerManaged: true,
  },
  {
    role: "pr-open-awaiting-merge",
    color: "#0E8A16",
    description: "PR is open and awaiting merge",
    runnerManaged: true,
  },
  {
    role: "ready-for-human",
    color: "#006B75",
    description: "Requires human implementation",
    runnerManaged: true,
  },
  {
    role: "needs-triage",
    color: "#E99695",
    description: "Maintainer needs to evaluate this issue",
    runnerManaged: false,
  },
  {
    role: "needs-info",
    color: "#F9D0C4",
    description: "Waiting on reporter for more information",
    runnerManaged: false,
  },
  {
    role: "wontfix",
    color: "#FFFFFF",
    description: "Will not be actioned",
    runnerManaged: false,
  },
  {
    role: "type:bugfix",
    color: "#D73A4A",
    description: "Priority label — bugfix (1)",
    runnerManaged: false,
  },
  {
    role: "type:infra",
    color: "#0E8A16",
    description: "Priority label — infrastructure (2)",
    runnerManaged: false,
  },
  {
    role: "type:feature",
    color: "#1D76DB",
    description: "Priority label — feature (3)",
    runnerManaged: false,
  },
  {
    role: "type:polish",
    color: "#5319E7",
    description: "Priority label — polish (4)",
    runnerManaged: false,
  },
  {
    role: "type:refactor",
    color: "#F9D0C4",
    description: "Priority label — refactor (5)",
    runnerManaged: false,
  },
];

const ROLE_TO_METADATA = new Map(
  CANONICAL_LABEL_METADATA.map((m) => [m.role, m])
);

const ROLE_TO_LABEL_KEY: Record<string, keyof RunnerLabelsConfig> = {
  "ready-for-agent": "readyForAgent",
  "agent-in-progress": "agentInProgress",
  blocked: "blocked",
  "pr-open-awaiting-merge": "prOpenAwaitingMerge",
  "ready-for-human": "readyForHuman",
};

export function resolveCanonicalLabels(
  runnerLabels: RunnerLabelsConfig
): CanonicalLabelDefinition[] {
  return CANONICAL_LABEL_METADATA.map((meta) => {
    const name = meta.runnerManaged
      ? runnerLabels[ROLE_TO_LABEL_KEY[meta.role]]
      : meta.role;
    return { ...meta, name };
  });
}

export interface PlanOptions {
  targetRoot: string;
  sourceRoot?: string;
  conflictPolicy?: InitConflictPolicy;
  legacySkills?: boolean;
  packageManager?: string;
  noGitCheck?: boolean;
  skipInstall?: boolean;
  labels?: RunnerLabelsConfig;
  labelConflictPolicy?: LabelConflictPolicy;
  githubClient?: GitHubClient;
}

export interface GeneratedConfigOptions {
  targetRoot: string;
  sourceRoot: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  baseBranch: string;
  verificationCommands: Array<{ label: string; command: string }>;
  hasPackageJson?: boolean;
  labels?: RunnerLabelsConfig;
}

export function inferVerificationCommands(
  scripts: Record<string, string>,
  pm: string
): Array<{ label: string; command: string }> {
  const pmPrefix =
    pm === "npm"
      ? "npm run"
      : pm === "pnpm"
        ? "pnpm run"
        : pm === "yarn"
          ? "yarn"
          : pm === "bun"
            ? "bun run"
            : "npm run";
  const allowlist: readonly string[] = ALLOWED_VERIFICATION_SCRIPTS;
  const matched = allowlist.filter((s) => s in scripts);
  const commands: Array<{ label: string; command: string }> = [];
  for (const script of matched) {
    if (script === "test" && matched.includes("test:agent")) continue;
    commands.push({ label: script, command: `${pmPrefix} ${script}` });
  }
  return commands;
}

export function generateConfigTemplate(
  options: GeneratedConfigOptions
): string {
  const {
    sourceRoot,
    targetRoot,
    packageManager,
    baseBranch,
    verificationCommands,
    hasPackageJson = true,
    labels: maybeLabels,
  } = options;
  const labels = maybeLabels ?? DEFAULT_RUNNER_LABELS;
  const relPath = path.relative(targetRoot, sourceRoot).replace(/\\/g, "/");
  const importPath = relPath || ".";
  const setupCommand = `${packageManager} install`;

  let setupSection: string;
  if (hasPackageJson) {
    setupSection = [
      "      setupCommands: [",
      `        { command: "${setupCommand}", label: "install" },`,
      "      ],",
    ].join("\n");
  } else {
    setupSection = "";
  }

  let verifySection: string;
  if (verificationCommands.length > 0) {
    const cmdLines = verificationCommands
      .map((vc) => `        { command: "${vc.command}", label: "${vc.label}" }`)
      .join(",\n");
    verifySection = [
      "        verify: {",
      "          commands: [",
      cmdLines,
      "          ],",
      "        },",
    ].join("\n");
  } else {
    verifySection = [
      "        // verify: {",
      "        //   commands: [",
      "        //     No matching scripts found in package.json.",
      "        //   ],",
      "        // },",
    ].join("\n");
  }

  return `import { definePourkitConfig } from "${importPath}/pourkit/shared/config";
import type { PourkitConfig } from "${importPath}/pourkit/shared/config";

export default definePourkitConfig({
  targets: [
    {
      name: "default",
      baseBranch: "${baseBranch}",
      branchTemplate: "pourkit/{{issue.number}}/{{issue.slug}}",
      autoMerge: false,
${setupSection}
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
${verifySection}
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
    readyForAgent: ${JSON.stringify(labels.readyForAgent)},
    agentInProgress: ${JSON.stringify(labels.agentInProgress)},
    blocked: ${JSON.stringify(labels.blocked)},
    prOpenAwaitingMerge: ${JSON.stringify(labels.prOpenAwaitingMerge)},
    readyForHuman: ${JSON.stringify(labels.readyForHuman)},
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
      XDG_CACHE_HOME: "/home/agent/.cache",
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
});
`;
}

function generateOpenCodeConfig(
  existingConfig: Record<string, unknown> = {}
): string {
  const { $schema, ...rest } = existingConfig;
  const existingAgents =
    typeof rest.agent === "object" &&
    rest.agent !== null &&
    !Array.isArray(rest.agent)
      ? rest.agent
      : {};
  return (
    JSON.stringify(
      {
        $schema:
          typeof $schema === "string"
            ? $schema
            : "https://opencode.ai/config.json",
        ...rest,
        agent: {
          ...DEFAULT_OPENCODE_AGENTS,
          ...existingAgents,
        },
      },
      null,
      2
    ) + "\n"
  );
}

const DEFAULT_OPENCODE_AGENTS = {
  "pourkit-builder": {
    mode: "primary",
    description: "Implements Pourkit issues as the Builder role.",
    permission: {
      task: {
        "*": "deny",
        "advisory-analyzer": "allow",
      },
    },
  },
  "pourkit-reviewer": {
    mode: "primary",
    description: "Produces authoritative Pourkit Reviewer artifacts.",
    permission: {
      task: "deny",
    },
  },
  "pourkit-refactor": {
    mode: "primary",
    description: "Addresses Pourkit Reviewer findings as the Refactor role.",
    permission: {
      task: {
        "*": "deny",
        "advisory-analyzer": "allow",
      },
    },
  },
  "pourkit-pr-description": {
    mode: "primary",
    description: "Writes Pourkit PR description artifacts.",
    permission: {
      task: "deny",
    },
  },
  "advisory-analyzer": {
    mode: "subagent",
    hidden: true,
    description:
      "Provides bounded advisory analysis for Pourkit Builder and Refactor only.",
    prompt: "{file:.pourkit/prompts/advisory-analyzer.prompt.md}",
    permission: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      edit: "deny",
      bash: "deny",
      task: "deny",
    },
  },
} as const;

export function generateTriageLabelsDoc(labels: RunnerLabelsConfig): string {
  return `# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| \`needs-triage\`             | \`needs-triage\`       | Maintainer needs to evaluate this issue  |
| \`needs-info\`               | \`needs-info\`         | Waiting on reporter for more information |
| \`ready-for-agent\`          | \`${labels.readyForAgent}\`    | Fully specified, ready for an AFK agent  |
| \`agent-in-progress\`        | \`${labels.agentInProgress}\`    | Agent is actively working on this issue  |
| \`ready-for-human\`          | \`${labels.readyForHuman}\`    | Requires human implementation            |
| \`wontfix\`                  | \`wontfix\`            | Will not be actioned                     |
| \`blocked\`                  | \`${labels.blocked}\`            | Has unresolved dependencies              |
| \`pr-open-awaiting-merge\`   | \`${labels.prOpenAwaitingMerge}\`            | PR is open and awaiting merge            |
| \`type:bugfix\`              | \`type:bugfix\`        | Priority label — bugfix (1)              |
| \`type:infra\`               | \`type:infra\`         | Priority label — infrastructure (2)      |
| \`type:feature\`             | \`type:feature\`       | Priority label — feature (3)             |
| \`type:polish\`              | \`type:polish\`        | Priority label — polish (4)              |
| \`type:refactor\`            | \`type:refactor\`      | Priority label — refactor (5)            |

## Label semantics for Pourkit

- \`${labels.readyForAgent}\` without \`${labels.blocked}\`: Pourkit may pick this issue.
- \`${labels.readyForAgent}\` with \`${labels.blocked}\`: Pourkit skips this issue during normal selection (dependencies unresolved).
- \`${labels.agentInProgress}\`: Set when an agent checks out an issue for implementation. Prevents other agents from picking it up.
- \`${labels.prOpenAwaitingMerge}\`: Set when a pull request is open and awaiting merge. The issue remains in this state until the PR is merged.
- In queue loop mode, Pourkit may reconcile blocked labels before selecting runnable work — a blocked issue remains blocked until its dependencies are resolved.
- AFK-track issues must carry exactly one \`type:*\` label. Pourkit rejects issues missing one or carrying more than one.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
`;
}

export function generateContextScaffold(): string {
  return `# Project Context

<Describe the project's purpose, architecture, and goals here.>

## Language

**Term**: Definition
_Avoid_: Alternative terms

## Relationships

<Document how key concepts relate to each other.>

## Example Dialogue

> **User:** Question about the project
> **Expert:** Response explaining relevant concepts

## Flagged Ambiguities

- <Document ambiguous terms and their resolution here.>
`;
}

export async function generateManagedAgentInstructions(options: {
  sourceRoot: string;
}): Promise<string> {
  const sourcePath = path.join(options.sourceRoot, "AGENTS.md");
  try {
    return await readFile(sourcePath, "utf-8");
  } catch {
    return `## Agent Skills

All repo-specific skills live in \`.agents/skills/\`. Load them by name when the task matches (e.g. \`work-on-issue\`, \`diagnose\`, \`security-review\`, \`grill-with-docs\`, \`tdd\`).

## Codebase exploration

Use \`fd\` for file discovery, \`rg\` for text search, and direct file reads for focused context.

Follow the project's domain docs and conventions documented in \`.pourkit/docs/agents/*\`.
`;
  }
}

export function generateGitignoreBlock(): string {
  const lines = [
    ".pourkit/logs/",
    ".pourkit/.tmp/",
    ".pourkit/state.json",
    ".sandcastle/worktrees/",
    ".sandcastle/logs/",
  ];
  return lines.join("\n") + "\n";
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDir(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function computeFileChecksum(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function lockfileExists(root: string, name: string): boolean {
  return existsSync(path.join(root, name));
}

export function detectPackageManager(root: string): string | null {
  if (lockfileExists(root, "pnpm-lock.yaml")) return "pnpm";
  if (lockfileExists(root, "yarn.lock")) return "yarn";
  if (lockfileExists(root, "bun.lock")) return "bun";
  if (lockfileExists(root, "package-lock.json")) return "npm";
  return null;
}

async function execGit(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export async function discoverLocalSource(
  sourcePath: string
): Promise<LocalSourceMetadata> {
  const branch = (
    await execGit(["rev-parse", "--abbrev-ref", "HEAD"], sourcePath)
  ).stdout.trim();
  const sha = (await execGit(["rev-parse", "HEAD"], sourcePath)).stdout.trim();
  const dirtyOutput = (
    await execGit(["status", "--porcelain"], sourcePath)
  ).stdout.trim();
  const sourceDirty = dirtyOutput.length > 0;

  const releaseChannel =
    branch === "main" || branch === "master" ? "stable" : "development";

  let latestTag: string | null = null;
  try {
    const tagResult = await execGit(
      ["describe", "--tags", "--abbrev=0", "--match", "v*"],
      sourcePath
    );
    latestTag = tagResult.stdout.trim() || null;
  } catch {
    latestTag = null;
  }

  return {
    versionSource: "local-git",
    sourceDirty,
    branch,
    sha,
    releaseChannel,
    latestTag,
  };
}

async function discoverReadme(root: string): Promise<string | null> {
  for (const name of ["README.md", "readme.md"]) {
    const p = path.join(root, name);
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

async function discoverAgentFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const p = path.join(root, name);
    if (existsSync(p)) {
      files.push(p);
    }
  }
  return files;
}

async function discoverMerlleState(root: string): Promise<string | null> {
  const p = path.join(root, ".pourkit", "state.json");
  return existsSync(p) ? p : null;
}

async function discoverAgentSkills(root: string): Promise<string[]> {
  const dirs = [
    path.join(root, ".agents", "skills"),
    path.join(root, ".opencode", "skills"),
  ];
  const found: string[] = [];
  for (const d of dirs) {
    if (existsSync(d)) {
      found.push(d);
    }
  }
  return found;
}

async function discoverRootDomainDocs(root: string): Promise<string[]> {
  const docs: string[] = [];
  for (const name of ["CONTEXT.md", "CONTEXT-MAP.md"]) {
    const p = path.join(root, name);
    if (existsSync(p)) {
      docs.push(p);
    }
  }
  const adrDir = path.join(root, "docs", "adr");
  if (existsSync(adrDir)) {
    const entries = await readdir(adrDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        docs.push(path.join(adrDir, entry.name));
      }
    }
  }
  return docs;
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    await execGit(["rev-parse", "--is-inside-work-tree"], root);
    return true;
  } catch {
    return false;
  }
}

async function hasGitHubRemote(root: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(["remote", "-v"], root);
    return stdout.includes("github.com");
  } catch {
    return false;
  }
}

async function checkExistingLabelConflicts(
  client: GitHubClient | undefined,
  canonicalLabels: CanonicalLabelDefinition[]
): Promise<boolean> {
  if (!client) return true;
  try {
    const { data } = await client.octokit.rest.issues.listLabelsForRepo({
      owner: client.owner,
      repo: client.repo,
      per_page: 200,
    });
    const existingMap = new Map(data.map((l) => [l.name, l]));
    for (const cl of canonicalLabels) {
      const existing = existingMap.get(cl.name);
      if (!existing) continue;
      const canonicalColor = cl.color.replace(/^#/, "").toLowerCase();
      const existingColor = existing.color.replace(/^#/, "").toLowerCase();
      if (
        existingColor !== canonicalColor ||
        existing.description !== cl.description
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export async function planInit(options: PlanOptions): Promise<InitPlan> {
  const { targetRoot, sourceRoot } = options;
  const operations: InitOperation[] = [];
  const warnings: string[] = [];
  let hasLabelConflicts = false;

  let managedAgentContent: string | undefined;
  if (sourceRoot) {
    managedAgentContent = await generateManagedAgentInstructions({
      sourceRoot,
    });
  }

  const pm = options.packageManager ?? detectPackageManager(targetRoot);
  if (pm) {
    operations.push({
      kind: "skip",
      reason: `Package manager: ${pm}`,
      requiresConfirmation: false,
      destructive: false,
    });
  } else {
    warnings.push("No package manager lockfile detected");
    operations.push({
      kind: "warn",
      reason: "No package manager lockfile detected",
      destructive: false,
      requiresConfirmation: false,
    });
  }

  const readme = await discoverReadme(targetRoot);
  if (!readme) {
    warnings.push("No README.md found at target root");
    operations.push({
      kind: "warn",
      reason: "No README.md found at target root",
      destructive: false,
      requiresConfirmation: false,
    });
  }

  const agentFiles = await discoverAgentFiles(targetRoot);
  if (agentFiles.length > 0) {
    for (const f of agentFiles) {
      if (sourceRoot) {
        const agentFileMode = options.conflictPolicy?.agentFile ?? "both";
        const basename = path.basename(f);
        if (
          agentFileMode === "skip" ||
          (agentFileMode === "agents" && basename !== "AGENTS.md") ||
          (agentFileMode === "claude" && basename !== "CLAUDE.md")
        ) {
          operations.push({
            kind: "skip",
            path: f,
            ownership: "project-owned",
            reason: `Existing agent file skipped per policy: ${basename}`,
            requiresConfirmation: false,
            destructive: false,
          });
          continue;
        }
        operations.push({
          kind: "update",
          path: f,
          ownership: "managed",
          reason: `Update existing ${basename} with Pourkit managed block`,
          requiresConfirmation: false,
          destructive: false,
          content: managedAgentContent!,
        });
      } else {
        operations.push({
          kind: "skip",
          path: f,
          ownership: "project-owned",
          reason: `Existing agent file: ${path.basename(f)}`,
          requiresConfirmation: false,
          destructive: false,
        });
      }
    }
  }

  const merlleState = await discoverMerlleState(targetRoot);
  if (merlleState) {
    operations.push({
      kind: "skip",
      path: merlleState,
      ownership: "managed",
      reason: "Existing .pourkit/state.json",
      requiresConfirmation: false,
      destructive: false,
    });
  }

  const skills = await discoverAgentSkills(targetRoot);
  for (const s of skills) {
    if (s.includes(".opencode") && options.legacySkills) {
      const skillFiles = await walkDir(s);
      for (const file of skillFiles) {
        const relPath = path.relative(s, file);
        const destPath = path.join(targetRoot, ".agents", "skills", relPath);
        if (!existsSync(destPath)) {
          operations.push({
            kind: "copy",
            sourcePath: file,
            path: destPath,
            ownership: "project-owned",
            reason: `Migrate legacy skill: ${path.join(".opencode/skills", relPath)}`,
            requiresConfirmation: false,
            destructive: false,
          });
        }
      }
    } else {
      const label = s.includes(".agents")
        ? ".agents/skills"
        : ".opencode/skills";
      operations.push({
        kind: "skip",
        path: s,
        reason: `Existing skill directory: ${label}`,
        requiresConfirmation: false,
        destructive: false,
      });
    }
  }

  const isTargetGit = options.noGitCheck ? false : await isGitRepo(targetRoot);
  if (isTargetGit) {
    const hasRemote = await hasGitHubRemote(targetRoot);
    if (!hasRemote) {
      warnings.push("No GitHub remote configured for target repository");
      operations.push({
        kind: "warn",
        reason: "No GitHub remote configured for target repository",
        destructive: false,
        requiresConfirmation: false,
      });
    } else {
      const labels = options.labels ?? DEFAULT_RUNNER_LABELS;
      const canonicalLabels = resolveCanonicalLabels(labels);
      for (const cl of canonicalLabels) {
        operations.push({
          kind: "provision-label",
          reason: `Provision label: ${cl.name}`,
          requiresConfirmation: false,
          destructive: false,
          labelName: cl.name,
          labelColor: cl.color,
          labelDescription: cl.description,
        });
      }
      hasLabelConflicts = await checkExistingLabelConflicts(
        options.githubClient,
        canonicalLabels
      );
    }
  } else {
    warnings.push("Target is not a Git repository");
    operations.push({
      kind: "warn",
      reason: "Target is not a Git repository",
      destructive: false,
      requiresConfirmation: false,
    });
  }

  if (sourceRoot) {
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      warnings.push(
        `--from-local path does not exist or is not a directory: ${sourceRoot}`
      );
      operations.push({
        kind: "warn",
        reason: `--from-local path does not exist or is not a directory: ${sourceRoot}`,
        destructive: false,
        requiresConfirmation: false,
      });
    } else {
      let sourceMeta: LocalSourceMetadata;
      try {
        sourceMeta = await discoverLocalSource(sourceRoot);
      } catch {
        sourceMeta = {
          versionSource: "local-path",
          sourceDirty: false,
          branch: "unknown",
          sha: "0000000",
          releaseChannel: "unknown",
          latestTag: null,
        };
        warnings.push(
          "Source is not a Git repository; version metadata unavailable"
        );
        operations.push({
          kind: "warn",
          reason:
            "Source is not a Git repository; version metadata unavailable",
          destructive: false,
          requiresConfirmation: false,
        });
      }

      if (sourceMeta.sourceDirty) {
        warnings.push("Local source has uncommitted changes");
        operations.push({
          kind: "warn",
          reason: "Local source has uncommitted changes",
          destructive: false,
          requiresConfirmation: false,
        });
      }

      const plannedSkillDests = new Set<string>();
      for (const op of operations) {
        if (op.kind === "copy" && op.path?.includes(".agents/skills")) {
          plannedSkillDests.add(op.path);
        }
      }

      const srcSkills = await discoverAgentSkills(sourceRoot);
      for (const s of srcSkills) {
        const isOpenCode = s.includes(".opencode");
        if (isOpenCode && !options.legacySkills) {
          operations.push({
            kind: "skip",
            reason:
              "Legacy .opencode/skills in source not copied; use --legacy-skills to migrate",
            requiresConfirmation: false,
            destructive: false,
          });
          continue;
        }
        const targetDirName = ".agents/skills";
        const targetPath = path.join(targetRoot, targetDirName);
        const skillFiles = await walkDir(s);
        for (const file of skillFiles) {
          const relPath = path.relative(s, file);
          const destPath = path.join(targetPath, relPath);
          if (plannedSkillDests.has(destPath)) {
            operations.push({
              kind: "skip",
              path: destPath,
              ownership: "project-owned",
              reason: `Skill destination conflict, skipping source copy: ${path.join(targetDirName, relPath)}`,
              requiresConfirmation: false,
              destructive: false,
              conflict: "destination already planned",
            });
            continue;
          }
          const checksum = await computeFileChecksum(file);
          operations.push({
            kind: "copy",
            sourcePath: file,
            path: destPath,
            ownership: "copied-customizable",
            reason: `Copy skill: ${path.join(targetDirName, relPath)}`,
            requiresConfirmation: false,
            destructive: false,
            checksum,
          });
        }
      }

      const srcReadme = await discoverReadme(sourceRoot);
      if (srcReadme && !readme) {
        operations.push({
          kind: "copy",
          sourcePath: srcReadme,
          path: path.join(targetRoot, "README.md"),
          ownership: "project-owned",
          reason: "Copy README.md from source",
          requiresConfirmation: false,
          destructive: false,
        });
      }

      // --- Root domain docs migration ---
      const docsMigration = options.conflictPolicy?.docsMigration ?? "copy";
      const rootDocs = await discoverRootDomainDocs(targetRoot);
      const merleDestPaths = new Set<string>();
      for (const docPath of rootDocs) {
        const relPath = path.relative(targetRoot, docPath);
        const destPath = path.join(targetRoot, ".pourkit", relPath);
        merleDestPaths.add(destPath);
        if (docsMigration === "skip") {
          operations.push({
            kind: "skip",
            path: docPath,
            ownership: "project-owned",
            reason: `Root domain doc skipped by policy: ${relPath}`,
            requiresConfirmation: false,
            destructive: false,
          });
        } else if (existsSync(destPath)) {
          operations.push({
            kind: "skip",
            path: destPath,
            ownership: "project-owned",
            reason: `Destination exists, skipping root domain doc: ${relPath}`,
            requiresConfirmation: false,
            destructive: false,
            conflict: "destination already exists",
          });
        } else if (docsMigration === "move" && options.conflictPolicy?.yes) {
          operations.push({
            kind: "move",
            sourcePath: docPath,
            path: destPath,
            ownership: "project-owned",
            reason: `Move root domain doc: ${relPath}`,
            requiresConfirmation: false,
            destructive: true,
          });
        } else {
          // copy by default (fallback for move-without-yes or explicit copy)
          operations.push({
            kind: "copy",
            sourcePath: docPath,
            path: destPath,
            ownership: "project-owned",
            reason: `Copy root domain doc: ${relPath}`,
            requiresConfirmation: false,
            destructive: false,
          });
        }
      }

      // --- Fresh-repo bootstrap assets ---

      let packageScripts: Record<string, string> = {};
      let hasPackageJson = true;
      try {
        const pkgContent = await readFile(
          path.join(targetRoot, "package.json"),
          "utf-8"
        );
        const pkg = JSON.parse(pkgContent);
        if (pkg.scripts && typeof pkg.scripts === "object") {
          packageScripts = pkg.scripts;
        }
      } catch {
        hasPackageJson = false;
      }

      let baseBranch = "main";
      if (isTargetGit) {
        try {
          const { stdout } = await execGit(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            targetRoot
          );
          baseBranch = stdout.trim() || "main";
        } catch {
          // fallback
        }
      }

      // 1. CONTEXT.md scaffold
      const contextPath = path.join(targetRoot, ".pourkit", "CONTEXT.md");
      if (!existsSync(contextPath) && !merleDestPaths.has(contextPath)) {
        operations.push({
          kind: "create",
          path: contextPath,
          ownership: "managed",
          reason: "Init CONTEXT.md scaffold",
          requiresConfirmation: false,
          destructive: false,
          content: generateContextScaffold(),
        });
      }

      // 2. ADR .gitkeep
      const adrGitkeep = path.join(
        targetRoot,
        ".pourkit",
        "docs",
        "adr",
        ".gitkeep"
      );
      if (!existsSync(adrGitkeep)) {
        operations.push({
          kind: "create",
          path: adrGitkeep,
          ownership: "managed",
          reason: "Init ADR directory placeholder",
          requiresConfirmation: false,
          destructive: false,
        });
      }

      // 3. .pourkit/docs/agents/ from source
      const srcDocAgents = path.join(sourceRoot, ".pourkit", "docs", "agents");
      const tgtDocAgents = path.join(targetRoot, ".pourkit", "docs", "agents");
      if (existsSync(srcDocAgents) && !existsSync(tgtDocAgents)) {
        const docFiles = await walkDir(srcDocAgents);
        for (const file of docFiles) {
          const relPath = path.relative(srcDocAgents, file);
          if (relPath === "triage-labels.md") {
            operations.push({
              kind: "create",
              path: path.join(tgtDocAgents, relPath),
              ownership: "managed",
              reason: "Init triage labels doc",
              requiresConfirmation: false,
              destructive: false,
              content: generateTriageLabelsDoc(
                options.labels ?? DEFAULT_RUNNER_LABELS
              ),
            });
            continue;
          }
          const checksum = await computeFileChecksum(file);
          operations.push({
            kind: "copy",
            sourcePath: file,
            path: path.join(tgtDocAgents, relPath),
            ownership: "managed",
            reason: `Copy agent doc: ${relPath}`,
            requiresConfirmation: false,
            destructive: false,
            checksum,
          });
        }
      }

      // 4. .pourkit/prompts/ from source
      const srcPrompts = path.join(sourceRoot, ".pourkit", "prompts");
      const tgtPrompts = path.join(targetRoot, ".pourkit", "prompts");
      if (existsSync(srcPrompts) && !existsSync(tgtPrompts)) {
        const promptFiles = await walkDir(srcPrompts);
        for (const file of promptFiles) {
          const relPath = path.relative(srcPrompts, file);
          const checksum = await computeFileChecksum(file);
          operations.push({
            kind: "copy",
            sourcePath: file,
            path: path.join(tgtPrompts, relPath),
            ownership: "managed",
            reason: `Copy prompt: ${relPath}`,
            requiresConfirmation: false,
            destructive: false,
            checksum,
          });
        }
      }

      // 5. Sandcastle Dockerfile from source
      const srcSandboxDockerfile = path.join(
        sourceRoot,
        ".sandcastle",
        "Dockerfile"
      );
      const tgtSandboxDockerfile = path.join(
        targetRoot,
        ".sandcastle",
        "Dockerfile"
      );
      if (existsSync(tgtSandboxDockerfile)) {
        operations.push({
          kind: "skip",
          path: tgtSandboxDockerfile,
          ownership: "project-owned",
          reason: "Existing .sandcastle/Dockerfile (project-owned)",
          requiresConfirmation: false,
          destructive: false,
        });
      } else if (existsSync(srcSandboxDockerfile)) {
        const checksum = await computeFileChecksum(srcSandboxDockerfile);
        operations.push({
          kind: "copy",
          sourcePath: srcSandboxDockerfile,
          path: tgtSandboxDockerfile,
          ownership: "managed",
          reason: "Copy default Sandcastle Dockerfile",
          requiresConfirmation: false,
          destructive: false,
          checksum,
        });
      }

      // 6. pourkit.config.ts template
      const configTsPath = path.join(targetRoot, "pourkit.config.ts");
      if (!existsSync(configTsPath)) {
        const verifyCommands = inferVerificationCommands(
          packageScripts,
          pm || "npm"
        );
        const configContent = generateConfigTemplate({
          targetRoot,
          sourceRoot,
          packageManager:
            (pm as GeneratedConfigOptions["packageManager"]) || "npm",
          baseBranch,
          verificationCommands: verifyCommands,
          hasPackageJson,
          labels: options.labels,
        });
        operations.push({
          kind: "create",
          path: configTsPath,
          ownership: "managed",
          reason: "Init pourkit.config.ts template",
          requiresConfirmation: false,
          destructive: false,
          content: configContent,
        });
      } else {
        operations.push({
          kind: "skip",
          path: configTsPath,
          ownership: "project-owned",
          reason: "Existing pourkit.config.ts (project-owned)",
          requiresConfirmation: false,
          destructive: false,
        });
      }

      // 7. Agent file managed blocks
      const agentFileMode = options.conflictPolicy?.agentFile ?? "both";

      const hasExistingAgents = operations.some(
        (op) =>
          (op.kind === "skip" || op.kind === "update") &&
          op.path?.endsWith("AGENTS.md")
      );
      if (
        (agentFileMode === "agents" || agentFileMode === "both") &&
        !hasExistingAgents &&
        !existsSync(path.join(targetRoot, "AGENTS.md"))
      ) {
        operations.push({
          kind: "create",
          path: path.join(targetRoot, "AGENTS.md"),
          ownership: "managed",
          reason: "Init AGENTS.md with Pourkit managed block",
          requiresConfirmation: false,
          destructive: false,
          content: `${MANAGED_BLOCK_BEGIN}\n${managedAgentContent!}${MANAGED_BLOCK_END}\n`,
        });
      }

      const hasExistingClaude = operations.some(
        (op) =>
          (op.kind === "skip" || op.kind === "update") &&
          op.path?.endsWith("CLAUDE.md")
      );
      if (
        (agentFileMode === "claude" || agentFileMode === "both") &&
        !hasExistingClaude &&
        !existsSync(path.join(targetRoot, "CLAUDE.md"))
      ) {
        operations.push({
          kind: "create",
          path: path.join(targetRoot, "CLAUDE.md"),
          ownership: "managed",
          reason: "Init CLAUDE.md with Pourkit managed block",
          requiresConfirmation: false,
          destructive: false,
          content: `${MANAGED_BLOCK_BEGIN}\n${managedAgentContent!}${MANAGED_BLOCK_END}\n`,
        });
      }

      // 8. .gitignore managed block
      const gitignoreTarget = path.join(targetRoot, ".gitignore");
      const gitignoreContent = generateGitignoreBlock();
      if (!existsSync(gitignoreTarget)) {
        operations.push({
          kind: "create",
          path: gitignoreTarget,
          ownership: "managed",
          reason: "Init .gitignore with Pourkit entries",
          requiresConfirmation: false,
          destructive: false,
          content: `${MANAGED_BLOCK_BEGIN}\n${gitignoreContent}${MANAGED_BLOCK_END}\n`,
        });
      } else {
        operations.push({
          kind: "update",
          path: gitignoreTarget,
          ownership: "managed",
          reason: "Update .gitignore with Pourkit managed block",
          requiresConfirmation: false,
          destructive: false,
          content: gitignoreContent,
        });
      }

      // 9. opencode.json config
      const openCodePath = path.join(targetRoot, "opencode.json");
      if (!existsSync(openCodePath)) {
        operations.push({
          kind: "create",
          path: openCodePath,
          ownership: "managed",
          reason: "Init opencode.json config",
          requiresConfirmation: false,
          destructive: false,
          content: generateOpenCodeConfig(),
        });
      } else {
        try {
          const existingContent = await readFile(openCodePath, "utf-8");
          const existingConfig = JSON.parse(existingContent);

          if (
            typeof existingConfig !== "object" ||
            existingConfig === null ||
            Array.isArray(existingConfig)
          ) {
            warnings.push(
              "Existing opencode.json is not a valid config object; skipping"
            );
            operations.push({
              kind: "warn",
              path: openCodePath,
              reason:
                "Existing opencode.json is not a valid config object; skipping",
              requiresConfirmation: false,
              destructive: false,
            });
          } else if (typeof existingConfig.$schema === "string") {
            operations.push({
              kind: "skip",
              path: openCodePath,
              ownership: "project-owned",
              reason: "Existing opencode.json config",
              requiresConfirmation: false,
              destructive: false,
            });
          } else {
            operations.push({
              kind: "create",
              path: openCodePath,
              ownership: "managed",
              reason: "Update opencode.json with schema",
              requiresConfirmation: false,
              destructive: true,
              content: generateOpenCodeConfig(existingConfig),
            });
          }
        } catch {
          warnings.push("Existing opencode.json is malformed; skipping");
          operations.push({
            kind: "warn",
            path: openCodePath,
            reason: "Existing opencode.json is malformed; skipping",
            requiresConfirmation: false,
            destructive: false,
          });
        }
      }

      // 10. .pourkit/manifest.json written last by writeManifest
      const manifestPath = path.join(targetRoot, ".pourkit", "manifest.json");
      if (existsSync(manifestPath)) {
        operations.push({
          kind: "skip",
          path: manifestPath,
          ownership: "managed",
          reason: "Existing .pourkit/manifest.json",
          requiresConfirmation: false,
          destructive: false,
          conflict: "already exists",
        });
      }

      const sourceLabel =
        sourceMeta.versionSource === "local-git"
          ? `Init from local source (${sourceMeta.branch}@${sourceMeta.sha.slice(0, 7)})`
          : "Init from local source (non-Git)";
      operations.push({
        kind: "copy",
        sourcePath: sourceRoot,
        path: targetRoot,
        ownership: "managed",
        reason: sourceLabel,
        requiresConfirmation: true,
        destructive: false,
      });
    }
  } else {
    warnings.push("No --from-local source provided");
    operations.push({
      kind: "warn",
      reason: "No --from-local source provided",
      destructive: false,
      requiresConfirmation: false,
    });
  }

  return {
    targetRoot,
    sourceRoot: sourceRoot ?? "",
    operations,
    warnings,
    hasLabelConflicts,
  };
}

const GROUP_LABELS: Record<InitOperationKind, string> = {
  create: "Create",
  update: "Update",
  copy: "Copy",
  move: "Move",
  skip: "Skip",
  warn: "Warn",
  install: "Install",
  "provision-label": "Labels",
};

const GROUP_ORDER: InitOperationKind[] = [
  "create",
  "update",
  "copy",
  "move",
  "provision-label",
  "skip",
  "warn",
  "install",
];

export function renderInitPlan(plan: InitPlan): string {
  const lines: string[] = [];
  lines.push(`Init Plan for ${plan.targetRoot}`);
  const fromSource = plan.sourceRoot ? ` (from ${plan.sourceRoot})` : "";
  if (fromSource) {
    lines[0] += fromSource;
  }
  lines.push("");

  for (const kind of GROUP_ORDER) {
    const group = plan.operations.filter((op) => op.kind === kind);
    if (group.length === 0) continue;
    lines.push(`  ${GROUP_LABELS[kind]}:`);
    for (const op of group) {
      const parts: string[] = [];
      if (op.path) parts.push(op.path);
      if (op.sourcePath) parts.push(`<- ${op.sourcePath}`);
      parts.push(`(${op.reason})`);
      lines.push(`    - ${parts.join(" ")}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("  Warnings:");
    for (const w of plan.warnings) {
      lines.push(`    ! ${w}`);
    }
  }

  lines.push("");
  lines.push(
    `${plan.operations.length} operation(s), ${plan.warnings.length} warning(s)`
  );
  return lines.join("\n");
}

export function renderInitPlanJson(plan: InitPlan): string {
  return JSON.stringify(plan, null, 2);
}

function normalizeLabelInput(
  result: string | symbol,
  defaultLabel: string
): string {
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return defaultLabel;
}

export async function promptForInitChoices(
  plan: InitPlan,
  current: {
    docsMigration?: DocsMigrationMode;
    agentFile?: AgentFileMode;
    packageManager?: string;
    legacySkills?: boolean;
    noGitCheck?: boolean;
    labels?: RunnerLabelsConfig;
  }
): Promise<{
  docsMigration: DocsMigrationMode;
  agentFile: AgentFileMode;
  packageManager?: string;
  legacySkills: boolean;
  noGitCheck: boolean;
  labels: RunnerLabelsConfig;
  cancelled: boolean;
}> {
  let docsMigration = current.docsMigration;
  let agentFile = current.agentFile;
  let packageManager = current.packageManager;
  let legacySkills = current.legacySkills ?? false;
  let noGitCheck = current.noGitCheck ?? false;
  const labels = current.labels
    ? { ...current.labels }
    : { ...DEFAULT_RUNNER_LABELS };

  if (
    !packageManager &&
    plan.warnings.some((w) => w.toLowerCase().includes("lockfile"))
  ) {
    const result = await select({
      message:
        "No package manager lockfile detected. Which package manager are you using?",
      options: [
        { value: "npm", label: "npm" },
        { value: "pnpm", label: "pnpm" },
        { value: "yarn", label: "yarn" },
        { value: "bun", label: "bun" },
      ],
    });
    if (isCancel(result)) {
      return {
        docsMigration: docsMigration ?? "copy",
        agentFile: agentFile ?? "both",
        packageManager,
        legacySkills,
        noGitCheck,
        labels,
        cancelled: true,
      };
    }
    packageManager = result as string;
  }

  if (
    !docsMigration &&
    plan.operations.some(
      (op) =>
        op.sourcePath &&
        op.path?.includes(".pourkit") &&
        (op.path?.endsWith("CONTEXT.md") ||
          op.path?.endsWith("CONTEXT-MAP.md") ||
          op.path?.includes("docs/adr"))
    )
  ) {
    const result = await select({
      message:
        "How should existing domain documentation be migrated to .pourkit/?",
      options: [
        { value: "copy", label: "Copy to .pourkit/ (safe default)" },
        { value: "skip", label: "Skip migration" },
      ],
    });
    if (isCancel(result)) {
      return {
        docsMigration: docsMigration ?? "copy",
        agentFile: agentFile ?? "both",
        packageManager,
        legacySkills,
        noGitCheck,
        labels,
        cancelled: true,
      };
    }
    docsMigration = result as DocsMigrationMode;
  }

  if (
    !agentFile &&
    plan.operations.some(
      (op) => op.path?.endsWith("AGENTS.md") || op.path?.endsWith("CLAUDE.md")
    )
  ) {
    const result = await select({
      message: "Which agent files should Pourkit manage?",
      options: [
        { value: "both", label: "Both AGENTS.md and CLAUDE.md" },
        { value: "agents", label: "AGENTS.md only" },
        { value: "claude", label: "CLAUDE.md only" },
        { value: "skip", label: "Skip agent file management" },
      ],
    });
    if (isCancel(result)) {
      return {
        docsMigration: docsMigration ?? "copy",
        agentFile: agentFile ?? "both",
        packageManager,
        legacySkills,
        noGitCheck,
        labels,
        cancelled: true,
      };
    }
    agentFile = result as AgentFileMode;
  }

  // --- Runner label configuration ---
  const readyForAgentResult = await text({
    message: "Label name for issues ready for agent pick-up?",
    placeholder: DEFAULT_RUNNER_LABELS.readyForAgent,
  });
  if (isCancel(readyForAgentResult)) {
    return {
      docsMigration: docsMigration ?? "copy",
      agentFile: agentFile ?? "both",
      packageManager,
      legacySkills,
      noGitCheck,
      labels,
      cancelled: true,
    };
  }
  labels.readyForAgent = normalizeLabelInput(
    readyForAgentResult,
    DEFAULT_RUNNER_LABELS.readyForAgent
  );

  const agentInProgressResult = await text({
    message: "Label name for issues currently being worked on by an agent?",
    placeholder: DEFAULT_RUNNER_LABELS.agentInProgress,
  });
  if (isCancel(agentInProgressResult)) {
    return {
      docsMigration: docsMigration ?? "copy",
      agentFile: agentFile ?? "both",
      packageManager,
      legacySkills,
      noGitCheck,
      labels,
      cancelled: true,
    };
  }
  labels.agentInProgress = normalizeLabelInput(
    agentInProgressResult,
    DEFAULT_RUNNER_LABELS.agentInProgress
  );

  const blockedResult = await text({
    message: "Label name for issues blocked by dependencies?",
    placeholder: DEFAULT_RUNNER_LABELS.blocked,
  });
  if (isCancel(blockedResult)) {
    return {
      docsMigration: docsMigration ?? "copy",
      agentFile: agentFile ?? "both",
      packageManager,
      legacySkills,
      noGitCheck,
      labels,
      cancelled: true,
    };
  }
  labels.blocked = normalizeLabelInput(
    blockedResult,
    DEFAULT_RUNNER_LABELS.blocked
  );

  const prOpenAwaitingMergeResult = await text({
    message: "Label name for PRs awaiting merge?",
    placeholder: DEFAULT_RUNNER_LABELS.prOpenAwaitingMerge,
  });
  if (isCancel(prOpenAwaitingMergeResult)) {
    return {
      docsMigration: docsMigration ?? "copy",
      agentFile: agentFile ?? "both",
      packageManager,
      legacySkills,
      noGitCheck,
      labels,
      cancelled: true,
    };
  }
  labels.prOpenAwaitingMerge = normalizeLabelInput(
    prOpenAwaitingMergeResult,
    DEFAULT_RUNNER_LABELS.prOpenAwaitingMerge
  );

  const readyForHumanResult = await text({
    message: "Label name for issues requiring human implementation?",
    placeholder: DEFAULT_RUNNER_LABELS.readyForHuman,
  });
  if (isCancel(readyForHumanResult)) {
    return {
      docsMigration: docsMigration ?? "copy",
      agentFile: agentFile ?? "both",
      packageManager,
      legacySkills,
      noGitCheck,
      labels,
      cancelled: true,
    };
  }
  labels.readyForHuman = normalizeLabelInput(
    readyForHumanResult,
    DEFAULT_RUNNER_LABELS.readyForHuman
  );

  if (plan.warnings.some((w) => w.toLowerCase().includes("uncommitted"))) {
    log.warn(
      "Local source has uncommitted changes — proceeding with dirty state."
    );
  }

  if (
    plan.warnings.some((w) => w.toLowerCase().includes("not a git")) &&
    !noGitCheck
  ) {
    const result = await confirm({
      message:
        "Target is not a Git repository. Continue without Git integration?",
      initialValue: false,
    });
    if (isCancel(result) || !result) {
      return {
        docsMigration: docsMigration ?? "copy",
        agentFile: agentFile ?? "both",
        packageManager,
        legacySkills,
        noGitCheck,
        labels,
        cancelled: true,
      };
    }
    noGitCheck = true;
  }

  return {
    docsMigration: docsMigration ?? "copy",
    agentFile: agentFile ?? "both",
    packageManager,
    legacySkills,
    noGitCheck,
    labels,
    cancelled: false,
  };
}

async function writeFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

const MANAGED_BLOCK_BEGIN = "<!-- BEGIN POURKIT MANAGED BLOCK -->";
const MANAGED_BLOCK_END = "<!-- END POURKIT MANAGED BLOCK -->";

async function updateManagedBlock(
  filePath: string,
  content: string
): Promise<void> {
  const blockContent = `${MANAGED_BLOCK_BEGIN}\n${content}${MANAGED_BLOCK_END}\n`;

  if (!existsSync(filePath)) {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(filePath, blockContent);
    return;
  }

  const existing = await readFile(filePath, "utf-8");
  const beginIdx = existing.indexOf(MANAGED_BLOCK_BEGIN);
  const endIdx = existing.indexOf(MANAGED_BLOCK_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + MANAGED_BLOCK_END.length);
    await writeFileAtomic(filePath, before + blockContent + after);
  } else {
    const suffix = existing.endsWith("\n") ? "" : "\n";
    await writeFileAtomic(filePath, existing + suffix + blockContent + "\n");
  }
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  errors: string[];
  warnings: string[];
}

export interface InitManifest {
  schemaVersion: 1;
  initializedAt: string;
  pourkit: {
    versionSource: "local-git";
    releaseVersion: string | null;
    releaseChannel: string;
    sourceBranch: string;
    sourceGitSha: string;
    sourceDirty: boolean;
    sourcePath: string;
  };
  agentFiles: string[];
  packageManager: string | null;
  assets: Record<string, { ownership: InitOwnership; sha256: string }>;
}

export async function writeManifest(
  plan: InitPlan,
  sourceMeta: LocalSourceMetadata,
  agentFiles: string[],
  packageManager: string | null
): Promise<InitManifest> {
  const manifestDir = path.join(plan.targetRoot, ".pourkit");
  const manifestPath = path.join(manifestDir, "manifest.json");

  const assets: Record<string, { ownership: InitOwnership; sha256: string }> =
    {};
  for (const op of plan.operations) {
    if (!op.path) continue;
    if (
      op.kind !== "create" &&
      op.kind !== "copy" &&
      op.kind !== "update" &&
      op.kind !== "move"
    )
      continue;
    if (op.requiresConfirmation) continue;
    const relPath = path.relative(plan.targetRoot, op.path);
    if (relPath === ".pourkit/manifest.json") continue;
    if (existsSync(op.path)) {
      const sha256 = await computeFileChecksum(op.path);
      assets[relPath] = {
        ownership: op.ownership || "managed",
        sha256,
      };
    }
  }

  const manifest: InitManifest = {
    schemaVersion: 1,
    initializedAt: new Date().toISOString(),
    pourkit: {
      versionSource: "local-git",
      releaseVersion: sourceMeta.latestTag,
      releaseChannel: sourceMeta.releaseChannel,
      sourceBranch: sourceMeta.branch,
      sourceGitSha: sourceMeta.sha,
      sourceDirty: sourceMeta.sourceDirty,
      sourcePath: plan.sourceRoot,
    },
    agentFiles,
    packageManager,
    assets,
  };

  await mkdir(manifestDir, { recursive: true });
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return manifest;
}

export type ExecCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<{ stdout: string; stderr: string }>;

export async function applyInitPlan(
  plan: InitPlan,
  options?: {
    labelConflictPolicy?: LabelConflictPolicy;
    execCommand?: ExecCommand;
    githubClient?: GitHubClient;
  }
): Promise<ApplyResult> {
  let applied = 0;
  let skipped = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const op of plan.operations) {
    if (op.requiresConfirmation) {
      skipped++;
      continue;
    }
    try {
      switch (op.kind) {
        case "create": {
          if (!op.path) {
            skipped++;
            continue;
          }
          if (existsSync(op.path) && !op.destructive) {
            skipped++;
            continue;
          }
          const dir = path.dirname(op.path);
          await mkdir(dir, { recursive: true });
          await writeFileAtomic(op.path, op.content ?? "");
          applied++;
          break;
        }
        case "copy": {
          if (!op.path || !op.sourcePath) {
            skipped++;
            continue;
          }
          if (existsSync(op.path)) {
            skipped++;
            continue;
          }
          const srcStat = statSync(op.sourcePath);
          if (srcStat.isDirectory()) {
            skipped++;
          } else {
            const dir = path.dirname(op.path);
            await mkdir(dir, { recursive: true });
            await copyFile(op.sourcePath, op.path);
            applied++;
          }
          break;
        }
        case "update": {
          if (!op.path) {
            skipped++;
            continue;
          }
          await updateManagedBlock(op.path, op.content ?? "");
          applied++;
          break;
        }
        case "move": {
          if (!op.path || !op.sourcePath) {
            skipped++;
            continue;
          }
          if (existsSync(op.path)) {
            skipped++;
            continue;
          }
          const dir = path.dirname(op.path);
          await mkdir(dir, { recursive: true });
          await rename(op.sourcePath, op.path);
          applied++;
          break;
        }
        case "provision-label": {
          if (!op.labelName) {
            skipped++;
            continue;
          }
          const client = options?.githubClient;
          if (!client) {
            warnings.push(NO_TOKEN_LABEL_PROVISIONING_WARNING);
            skipped++;
            continue;
          }
          const policy =
            options?.labelConflictPolicy ?? "skip-metadata-changes";
          const labelColor = (op.labelColor ?? "").replace(/^#/, "");
          try {
            await client.octokit.rest.issues.createLabel({
              owner: client.owner,
              repo: client.repo,
              name: op.labelName,
              color: labelColor,
              description: op.labelDescription ?? "",
            });
            applied++;
          } catch {
            if (policy === "update-to-pourkit") {
              try {
                await client.octokit.rest.issues.updateLabel({
                  owner: client.owner,
                  repo: client.repo,
                  name: op.labelName,
                  color: labelColor,
                  description: op.labelDescription ?? "",
                });
                warnings.push(
                  `Updated existing label metadata: ${op.labelName}`
                );
                applied++;
              } catch (editErr) {
                warnings.push(
                  `Failed to update label metadata for ${op.labelName}: ${editErr instanceof Error ? editErr.message : String(editErr)}`
                );
                skipped++;
              }
            } else if (policy === "keep-existing") {
              warnings.push(
                `Label already exists, keeping existing metadata: ${op.labelName}`
              );
              skipped++;
            } else {
              warnings.push(
                `Label creation skipped for ${op.labelName}: already exists (policy: skip-metadata-changes)`
              );
              skipped++;
            }
          }
          break;
        }
        case "skip":
        case "warn":
        case "install":
          skipped++;
          break;
      }
    } catch (e) {
      errors.push(
        `Failed to apply ${op.kind} ${op.path ?? ""}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return { applied, skipped, errors, warnings };
}

export interface ApplyInitFromSourceOptions {
  targetRoot: string;
  fromLocal: string;
  dryRun?: boolean;
  conflictPolicy?: InitConflictPolicy;
  legacySkills?: boolean;
  packageManager?: string;
  noGitCheck?: boolean;
  skipInstall?: boolean;
  labels?: RunnerLabelsConfig;
  labelConflictPolicy?: LabelConflictPolicy;
}

export interface ApplyInitFromSourceResult {
  applied: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  manifestWritten: boolean;
}

export async function applyInitFromSource(
  options: ApplyInitFromSourceOptions
): Promise<ApplyInitFromSourceResult> {
  const {
    targetRoot,
    fromLocal,
    dryRun = false,
    conflictPolicy,
    legacySkills,
    packageManager,
    noGitCheck,
    skipInstall,
    labelConflictPolicy,
  } = options;

  const ghClientResult = await tryCreateGitHubClient({ cwd: targetRoot });
  const githubClient = ghClientResult.ok ? ghClientResult.client : undefined;

  const plan = await planInit({
    targetRoot,
    sourceRoot: fromLocal,
    conflictPolicy,
    legacySkills,
    packageManager,
    noGitCheck,
    skipInstall,
    labels: options.labels,
    labelConflictPolicy,
    githubClient,
  });

  if (dryRun) {
    return {
      applied: 0,
      skipped: 0,
      errors: [],
      warnings: [],
      manifestWritten: false,
    };
  }

  let sourceMeta: LocalSourceMetadata;
  try {
    sourceMeta = await discoverLocalSource(fromLocal);
  } catch {
    sourceMeta = {
      versionSource: "local-path",
      sourceDirty: false,
      branch: "unknown",
      sha: "0000000",
      releaseChannel: "unknown",
      latestTag: null,
    };
  }

  const result = await applyInitPlan(plan, {
    labelConflictPolicy,
    githubClient,
  });

  let manifestWritten = false;
  if (result.errors.length === 0) {
    const manifestSkipped = plan.operations.some(
      (op) =>
        op.kind === "skip" &&
        op.path === path.join(targetRoot, ".pourkit", "manifest.json")
    );
    if (!manifestSkipped) {
      const agentFiles: string[] = [];
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        if (existsSync(path.join(targetRoot, name))) {
          agentFiles.push(path.join(targetRoot, name));
        }
      }
      const pm = detectPackageManager(targetRoot);
      await writeManifest(plan, sourceMeta, agentFiles, pm);
      manifestWritten = true;
    }
  }

  return { ...result, manifestWritten };
}

export async function runInitCommand(options: InitCliOptions): Promise<void> {
  const targetRoot = options.cwd ?? process.cwd();
  const isInteractive = process.stdin.isTTY && !options.yes;

  if (options.json && !options.dryRun) {
    console.error("Error: --json is only supported with --dry-run.");
    process.exit(1);
  }

  if (options.docsMigration === "move" && !options.yes) {
    throw new Error("--docs-migration move requires --yes.");
  }

  if (!isInteractive && !options.yes && !options.dryRun) {
    const missing: string[] = [];
    if (!options.fromLocal) missing.push("--from-local");
    if (!options.docsMigration) missing.push("--docs-migration");
    if (!options.agentFile) missing.push("--agent-file");
    if (!options.packageManager) {
      const pm = detectPackageManager(targetRoot);
      if (!pm) missing.push("--package-manager");
    }
    if (options.docsMigration === "move" && !options.yes) {
      missing.push("--yes (required for --docs-migration move)");
    }
    if (missing.length > 0) {
      throw new Error(`Missing required init options: ${missing.join(", ")}`);
    }
  }

  let promptLabels: RunnerLabelsConfig | undefined;

  if (isInteractive) {
    const discoveryPlan = await planInit({
      targetRoot,
      sourceRoot: options.fromLocal,
      conflictPolicy: options.fromLocal
        ? {
            docsMigration: options.docsMigration ?? "copy",
            agentFile: options.agentFile ?? "both",
            yes: false,
          }
        : undefined,
      legacySkills: options.legacySkills,
      packageManager: options.packageManager,
      noGitCheck: options.noGitCheck,
      skipInstall: options.skipInstall,
    });

    const promptResult = await promptForInitChoices(discoveryPlan, {
      docsMigration: options.docsMigration,
      agentFile: options.agentFile,
      packageManager: options.packageManager,
      legacySkills: options.legacySkills,
      noGitCheck: options.noGitCheck,
    });

    if (promptResult.cancelled) {
      log.info("Init cancelled.");
      return;
    }

    options = {
      ...options,
      docsMigration: options.docsMigration ?? promptResult.docsMigration,
      agentFile: options.agentFile ?? promptResult.agentFile,
      packageManager:
        options.packageManager ??
        (promptResult.packageManager as
          | "npm"
          | "pnpm"
          | "yarn"
          | "bun"
          | undefined),
      legacySkills: options.legacySkills ?? promptResult.legacySkills,
      noGitCheck: options.noGitCheck ?? promptResult.noGitCheck,
    };
    promptLabels = promptResult.labels;
  }

  const conflictPolicy = options.fromLocal
    ? {
        docsMigration: options.docsMigration ?? ("copy" as DocsMigrationMode),
        agentFile: options.agentFile ?? ("both" as AgentFileMode),
        yes: options.yes ?? false,
      }
    : undefined;

  const planLabels = isInteractive
    ? (promptLabels ?? DEFAULT_RUNNER_LABELS)
    : DEFAULT_RUNNER_LABELS;

  const plan = await planInit({
    targetRoot,
    sourceRoot: options.fromLocal,
    conflictPolicy,
    legacySkills: options.legacySkills,
    packageManager: options.packageManager,
    noGitCheck: options.noGitCheck,
    skipInstall: options.skipInstall,
    labels: planLabels,
  });

  let planLabelConflictPolicy: LabelConflictPolicy = "skip-metadata-changes";
  if (isInteractive && plan.hasLabelConflicts) {
    const conflictResult = await select({
      message:
        "How should existing GitHub label metadata conflicts be handled?",
      options: [
        {
          value: "skip-metadata-changes",
          label: "Skip metadata changes (safe default)",
        },
        {
          value: "keep-existing",
          label: "Keep existing label metadata",
        },
        {
          value: "update-to-pourkit",
          label: "Update to Pourkit metadata",
        },
      ],
    });
    if (isCancel(conflictResult)) {
      log.info("Init cancelled.");
      return;
    }
    planLabelConflictPolicy = conflictResult as LabelConflictPolicy;
  }

  if (options.json) {
    console.log(renderInitPlanJson(plan));
  } else {
    console.log(renderInitPlan(plan));
  }

  if (plan.warnings.length > 0 && !options.json) {
    console.error(
      `\n${plan.warnings.length} warning(s) — review above before applying.`
    );
  }

  if (options.dryRun) {
    if (!options.json) {
      console.log("\nDry-run — no files were written.");
    }
    return;
  }

  if (!options.fromLocal) {
    console.error(
      "\nError: --from-local <path> is required to apply the init plan."
    );
    process.exit(1);
  }

  const result = await applyInitFromSource({
    targetRoot,
    fromLocal: options.fromLocal,
    conflictPolicy,
    legacySkills: options.legacySkills,
    packageManager: options.packageManager,
    noGitCheck: options.noGitCheck,
    skipInstall: options.skipInstall,
    labels: planLabels,
    labelConflictPolicy: planLabelConflictPolicy,
  });

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`  ERROR: ${err}`);
    }
    console.error(
      `\nInit apply failed with ${result.errors.length} error(s). No manifest written.`
    );
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`  WARN: ${w}`);
    }
  }

  console.log(
    `\nInit applied: ${result.applied} operations applied, ${result.skipped} skipped.`
  );
  if (!options.json) {
    if (result.manifestWritten) {
      console.log(`Manifest written: .pourkit/manifest.json`);
    } else {
      console.log(`Existing manifest preserved.`);
    }
  }
}

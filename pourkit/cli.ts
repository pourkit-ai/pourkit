import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, Option, CommanderError } from "commander";
import { loadRepoConfig, resolveTarget } from "./shared/config";
import { cleanupRepository } from "./shared/cleanup";
import { runIssueCommand } from "./commands/issue";
import { runQueueCommand } from "./commands/queue-run";
import { runPrCreateCommand } from "./commands/pr-create";
import { runPrMergeCommand } from "./commands/pr-merge";
import type { InitCliOptions } from "./commands/init";
import { runInitCommand } from "./commands/init";
import { GitHubIssueProvider } from "./providers/github-provider";
import { GitHubPRProvider } from "./providers/github-pr-provider";
import { requireGitHubClient } from "./providers/github-client";
import { createLogger, execCapture, repoRoot } from "./shared/common";
import { SandcastleExecutionProvider } from "./execution/sandcastle-execution";

function normalizePrdRef(ref: string): string {
  const normalized = ref.trim().toUpperCase();
  if (!/^PRD-\d+$/.test(normalized)) {
    throw new Error(
      `Invalid PRD ref "${ref}". Expected format: PRD-<number> (e.g., PRD-021)`
    );
  }
  return normalized;
}

function buildPrCreateArgs(options: {
  target: string;
  title: string;
  base?: string;
  head?: string;
  body?: string;
  bodyFile?: string;
  issues: string[];
}): string[] {
  const args = ["--target", options.target, "--title", options.title];

  if (options.base) {
    args.push("--base", options.base);
  }

  if (options.head) {
    args.push("--head", options.head);
  }

  if (options.body !== undefined) {
    args.push("--body", options.body);
  }

  if (options.bodyFile !== undefined) {
    args.push("--body-file", options.bodyFile);
  }

  for (const issue of options.issues) {
    args.push("--issue", issue);
  }

  return args;
}

function buildPrMergeArgs(options: {
  prNumber: string;
  target?: string;
  method?: string;
  wait?: boolean;
  targetGreen?: boolean;
}): string[] {
  const args = [options.prNumber];

  if (options.target) {
    args.push("--target", options.target);
  }

  if (options.method) {
    args.push("--method", options.method);
  }

  if (options.wait === false) {
    args.push("--no-wait");
  }

  if (options.targetGreen === false) {
    args.push("--no-target-green");
  }

  return args;
}

const DEVELOPMENT_VERSION = "0.0.0-development";

function isReleaseVersion(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^v\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(value)
  );
}

function isPackageVersion(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(value)
  );
}

async function handleError(
  logger: {
    step: (level: string, message: string) => void;
    close: () => Promise<void>;
  },
  error: unknown
): Promise<never> {
  const msg = error instanceof Error ? error.message : String(error);
  logger.step("error", msg);
  await logger.close();
  console.error(`Error: ${msg}`);
  process.exit(1);
}

export function createCliProgram(version: string): Command {
  const program = new Command();

  program
    .name("pourkit")
    .version(version)
    .exitOverride()
    .description("AI-driven issue-to-PR workflow for GitHub repositories.");

  program
    .command("issue")
    .argument("<number>", "issue number")
    .requiredOption("--target <name>", "target name")
    .option("--force", "bypass issue gates")
    .option(
      "--reset-worktree",
      "delete local issue worktree and branch before starting"
    )
    .option("--cwd <path>", "target repository directory")
    .action(
      async (
        issueNumberRaw: string,
        options: {
          target: string;
          force?: boolean;
          resetWorktree?: boolean;
          cwd?: string;
        }
      ) => {
        const issueNumber = Number.parseInt(issueNumberRaw, 10);
        if (Number.isNaN(issueNumber)) {
          console.error(`Invalid issue number: ${issueNumberRaw}`);
          process.exit(1);
        }

        const targetRepoRoot = options.cwd ? repoRoot(options.cwd) : repoRoot();
        const config = await loadRepoConfig(targetRepoRoot);
        const logPath = path.join(
          targetRepoRoot,
          ".pourkit",
          "logs",
          `issue-${issueNumber}.log`
        );
        const logger = createLogger("pourkit", logPath);
        const client = await requireGitHubClient({ cwd: targetRepoRoot });
        const issueProvider = new GitHubIssueProvider(client, {
          readyForAgentLabel: config.labels.readyForAgent,
          issueListLimit: config.checks.issueListLimit,
        });
        const prProvider = new GitHubPRProvider(client, logger);
        const executionProvider = new SandcastleExecutionProvider();

        try {
          await cleanupRepository({
            repoRoot: targetRepoRoot,
            config,
            issueProvider,
            prProvider,
            logger,
          });
        } catch (err) {
          logger.step("warn", `Cleanup failed: ${err}`);
        }

        try {
          const result = await runIssueCommand({
            issueNumber,
            targetName: options.target,
            config,
            issueProvider,
            prProvider,
            executionProvider,
            force: options.force ?? false,
            resetWorktree: options.resetWorktree ?? false,
            logger,
            repoRoot: targetRepoRoot,
          });

          logger.raw("Issue completed successfully:");
          logger.raw(`  Branch: ${result.branchName}`);
          if (result.noOp) {
            logger.raw("  Status: no-op (closed without PR)");
          } else {
            logger.raw(`  PR Title: ${result.prTitle}`);
            logger.raw(`  PR Number: ${result.prNumber}`);
            logger.raw(`  PR URL: ${result.prUrl}`);
          }
          logger.raw(`  Target: ${result.target.name}`);
          await logger.close();
        } catch (error) {
          await handleError(logger, error);
        }
      }
    );

  program
    .command("queue-run")
    .requiredOption("--target <name>", "target name")
    .option("--force", "bypass issue gates")
    .option("--loop", "process runnable issues until the queue is drained")
    .option("--cwd <path>", "target repository directory")
    .option("--prd <ref>", "limit queue selection to child issues under a PRD")
    .action(
      async (options: {
        target: string;
        force?: boolean;
        loop?: boolean;
        cwd?: string;
        prd?: string;
      }) => {
        const prdRef = options.prd ? normalizePrdRef(options.prd) : undefined;
        const targetRepoRoot = options.cwd ? repoRoot(options.cwd) : repoRoot();
        const config = await loadRepoConfig(targetRepoRoot);
        const logPath = path.join(
          targetRepoRoot,
          ".pourkit",
          "logs",
          "queue-run.log"
        );
        const logger = createLogger("pourkit", logPath);
        const client = await requireGitHubClient({ cwd: targetRepoRoot });
        const issueProvider = new GitHubIssueProvider(client, {
          readyForAgentLabel: config.labels.readyForAgent,
          blockedLabel: config.labels.blocked,
          issueListLimit: config.checks.issueListLimit,
        });
        const prProvider = new GitHubPRProvider(client, logger);
        const executionProvider = new SandcastleExecutionProvider();

        try {
          await cleanupRepository({
            repoRoot: targetRepoRoot,
            config,
            issueProvider,
            prProvider,
            logger,
          });
        } catch (err) {
          logger.step("warn", `Cleanup failed: ${err}`);
        }

        try {
          const target = resolveTarget(config, options.target);
          const outcome = await runQueueCommand({
            targetName: options.target,
            config,
            issueProvider,
            prProvider,
            executionProvider,
            force: options.force ?? false,
            loop: options.loop ?? target.queue?.loop ?? false,
            logger,
            repoRoot: targetRepoRoot,
            prdRef,
          });

          if (outcome.selected === null) {
            if (outcome.code === "drained") {
              logger.step("info", outcome.reason);
              await logger.close();
              return;
            }
            logger.step("warn", outcome.reason);
            await logger.close();
            if (outcome.code === "no-candidates") {
              console.error(`No candidate issues: ${outcome.reason}`);
            } else {
              console.error(`No runnable issue: ${outcome.reason}`);
            }
            process.exit(1);
          }

          await logger.close();
        } catch (error) {
          await handleError(logger, error);
        }
      }
    );

  program
    .command("init")
    .description("Initialize .pourkit layout in a target repo")
    .option("--dry-run", "print the init plan without applying changes")
    .option("--json", "output machine-readable JSON plan")
    .option("--from-local <path>", "local source repo to copy artifacts from")
    .option("--cwd <path>", "target repository directory")
    .addOption(
      new Option(
        "--docs-migration <mode>",
        "docs migration mode: copy, move, skip"
      ).choices(["copy", "move", "skip"])
    )
    .option("--yes", "auto-confirm init plan")
    .addOption(
      new Option(
        "--agent-file <mode>",
        "agent file mode: both, agents, claude, skip"
      ).choices(["both", "agents", "claude", "skip"])
    )
    .option(
      "--legacy-skills",
      "migrate legacy .opencode/skills to .agents/skills"
    )
    .addOption(
      new Option(
        "--package-manager <name>",
        "package manager (override detection)"
      ).choices(["npm", "pnpm", "yarn", "bun"])
    )
    .option("--no-git-check", "skip Git repository validation")
    .option("--skip-install", "skip dependency installation (future use)")
    .action(
      async (
        options: {
          dryRun?: boolean;
          json?: boolean;
          fromLocal?: string;
          cwd?: string;
          docsMigration?: string;
          yes?: boolean;
          agentFile?: string;
          legacySkills?: boolean;
          packageManager?: string;
          noGitCheck?: boolean;
          gitCheck?: boolean;
          skipInstall?: boolean;
        },
        _command: Command
      ) => {
        const initOptions: InitCliOptions = {
          cwd: options.cwd,
          fromLocal: options.fromLocal,
          dryRun: options.dryRun,
          json: options.json,
          yes: options.yes,
          docsMigration: options.docsMigration as
            | "copy"
            | "move"
            | "skip"
            | undefined,
          agentFile: options.agentFile as
            | "both"
            | "agents"
            | "claude"
            | "skip"
            | undefined,
          legacySkills: options.legacySkills,
          packageManager: options.packageManager as
            | "npm"
            | "pnpm"
            | "yarn"
            | "bun"
            | undefined,
          noGitCheck: options.gitCheck === false ? true : undefined,
          skipInstall: options.skipInstall,
        };

        await runInitCommand(initOptions);
      }
    );

  const pr = program.command("pr").description("Pull request commands");

  pr.command("create")
    .requiredOption("--target <name>", "target name")
    .requiredOption("--title <title>", "PR title")
    .option("--base <base>", "base branch")
    .option("--head <branch>", "head branch")
    .option("--body <body>", "PR body")
    .option("--body-file <path>", "file to read PR body from")
    .option(
      "--issue <number>",
      "issue number to link",
      (value: string, previous: string[]) => {
        previous.push(value);
        return previous;
      },
      [] as string[]
    )
    .option("--cwd <path>", "target repository directory")
    .action(
      async (options: {
        target: string;
        title: string;
        base?: string;
        head?: string;
        body?: string;
        bodyFile?: string;
        issue: string[];
        cwd?: string;
      }) => {
        const targetRepoRoot = options.cwd ? repoRoot(options.cwd) : repoRoot();
        const config = await loadRepoConfig(targetRepoRoot);
        const logPath = path.join(
          targetRepoRoot,
          ".pourkit",
          "logs",
          "pr-create.log"
        );
        const logger = createLogger("pourkit", logPath);
        const client = await requireGitHubClient({ cwd: targetRepoRoot });
        const prProvider = new GitHubPRProvider(client, logger);

        try {
          const result = await runPrCreateCommand(
            buildPrCreateArgs({
              target: options.target,
              title: options.title,
              base: options.base,
              head: options.head,
              body: options.body,
              bodyFile: options.bodyFile,
              issues: options.issue,
            }),
            logger,
            prProvider,
            config,
            targetRepoRoot
          );

          logger.raw("PR created successfully:");
          logger.raw(`  Title: ${result.options.title}`);
          logger.raw(`  Head: ${result.currentBranch}`);
          logger.raw(`  Base: ${result.baseBranch}`);
          logger.raw(`  PR Number: ${result.prNumber}`);
          logger.raw(`  PR URL: ${result.prUrl}`);
          await logger.close();
        } catch (error) {
          await handleError(logger, error);
        }
      }
    );

  pr.command("merge")
    .argument("<number>", "pull request number")
    .option("--target <name>", "target name used to validate PR base branch")
    .addOption(
      new Option("--method <method>", "merge method")
        .choices(["merge", "squash", "rebase"])
        .default("squash")
    )
    .option("--no-wait", "merge immediately without waiting for PR checks")
    .option(
      "--no-target-green",
      "skip waiting for the target branch to be green after merge"
    )
    .option("--cwd <path>", "target repository directory")
    .action(
      async (
        prNumber: string,
        options: {
          target?: string;
          method?: string;
          wait?: boolean;
          targetGreen?: boolean;
          cwd?: string;
        }
      ) => {
        const targetRepoRoot = options.cwd ? repoRoot(options.cwd) : repoRoot();
        const config = await loadRepoConfig(targetRepoRoot);
        const logPath = path.join(
          targetRepoRoot,
          ".pourkit",
          "logs",
          "pr-merge.log"
        );
        const logger = createLogger("pourkit", logPath);
        const client = await requireGitHubClient({ cwd: targetRepoRoot });
        const prProvider = new GitHubPRProvider(client, logger);

        try {
          const result = await runPrMergeCommand(
            buildPrMergeArgs({
              prNumber,
              target: options.target,
              method: options.method,
              wait: options.wait,
              targetGreen: options.targetGreen,
            }),
            logger,
            prProvider,
            config
          );

          logger.raw("PR merged successfully:");
          logger.raw(`  Title: ${result.prTitle}`);
          logger.raw(`  Base: ${result.baseBranch}`);
          logger.raw(`  Method: ${result.options.method}`);
          logger.raw(`  PR Number: ${result.prNumber}`);
          logger.raw(`  PR URL: ${result.prUrl}`);
          await logger.close();
        } catch (error) {
          await handleError(logger, error);
        }
      }
    );

  return program;
}

export async function resolveCliVersion(): Promise<string> {
  if (isPackageVersion(process.env.POURKIT_CLI_VERSION)) {
    return process.env.POURKIT_CLI_VERSION;
  }

  if (isReleaseVersion(process.env.POURKIT_CLI_VERSION)) {
    return process.env.POURKIT_CLI_VERSION;
  }

  try {
    const root = repoRoot();
    const { stdout } = await execCapture(
      "git",
      [
        "tag",
        "--list",
        "v[0-9]*",
        "--sort=-version:refname",
        "--merged",
        "HEAD",
      ],
      { cwd: root }
    );
    const validTag = stdout
      .trim()
      .split("\n")
      .filter((t) => t.length > 0)
      .find((t) => isReleaseVersion(t));
    if (validTag) {
      return validTag;
    }
  } catch {
    return DEVELOPMENT_VERSION;
  }

  return DEVELOPMENT_VERSION;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const version = await resolveCliVersion();
  const program = createCliProgram(version);

  if (argv.length === 0) {
    program.outputHelp();
    process.exitCode = 1;
    return;
  }

  await program.parseAsync(argv, { from: "user" });
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return;
      process.exitCode = error.exitCode;
      return;
    }
    console.error(
      `Fatal: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}

import {
  resolveTarget,
  type PourkitConfig,
  type Target,
} from "../shared/config";
import {
  buildPrBody,
  DEFAULT_MANUAL_PR_BODY,
  type PrBodyOptions,
} from "../pr/pr-body";
import { createLogger } from "../shared/common";
import { runPrWorkflow } from "../pr/pr-workflow";
import type { PRProvider } from "../providers/pr-provider";

export interface PrCreateOptions {
  target: string;
  title: string;
  base?: string;
  head?: string;
  body?: string;
  bodyFile?: string;
  issue?: number;
}

export interface PrCreateResult {
  config: PourkitConfig;
  target: Target;
  options: PrCreateOptions;
  renderedBody: string;
  baseBranch: string;
  currentBranch: string;
  prNumber: number;
  prUrl: string;
}

function isFlag(value: string): boolean {
  return value.startsWith("--");
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || isFlag(value)) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePrCreateArgs(args: string[]): {
  options: PrCreateOptions;
  remaining: string[];
} {
  let target: string | undefined;
  let title: string | undefined;
  let base: string | undefined;
  let head: string | undefined;
  let body: string | undefined;
  let bodyFile: string | undefined;
  let issue: number | undefined;
  const remaining: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--target") {
      target = requireFlagValue("--target", args[i + 1]);
      i += 2;
    } else if (arg === "--title") {
      title = requireFlagValue("--title", args[i + 1]);
      i += 2;
    } else if (arg === "--base") {
      base = requireFlagValue("--base", args[i + 1]);
      i += 2;
    } else if (arg === "--head") {
      head = requireFlagValue("--head", args[i + 1]);
      i += 2;
    } else if (arg === "--body") {
      body = requireFlagValue("--body", args[i + 1]);
      i += 2;
    } else if (arg === "--body-file") {
      bodyFile = requireFlagValue("--body-file", args[i + 1]);
      i += 2;
    } else if (arg === "--issue") {
      const raw = requireFlagValue("--issue", args[i + 1]);
      if (!/^\d+$/.test(raw)) {
        throw new Error(`Invalid issue number: ${raw}`);
      }
      if (issue !== undefined) {
        throw new Error("at most one --issue is allowed");
      }
      issue = parseInt(raw, 10);
      i += 2;
    } else {
      remaining.push(arg);
      i++;
    }
  }

  return {
    options: {
      target: target!,
      title: title!,
      base,
      head,
      body,
      bodyFile,
      issue,
    },
    remaining,
  };
}

export function validatePrCreateOptions(options: PrCreateOptions): void {
  const errors: string[] = [];

  if (!options.target) {
    errors.push("--target is required");
  }

  if (!options.title) {
    errors.push("--title is required");
  }

  if (options.body && options.bodyFile) {
    errors.push("--body and --body-file cannot be used together");
  }

  if (options.head !== undefined && options.head.trim() === "") {
    errors.push("--head must be a non-empty string");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export async function runPrCreateCommand(
  args: string[],
  logger?: ReturnType<typeof createLogger>,
  prProvider?: PRProvider,
  config?: PourkitConfig,
  repoRoot?: string
): Promise<PrCreateResult> {
  const { options, remaining } = parsePrCreateArgs(args);

  if (remaining.length > 0) {
    throw new Error(`Unsupported arguments: ${remaining.join(" ")}`);
  }

  validatePrCreateOptions(options);

  if (!config) {
    throw new Error("Config is required");
  }

  const target = resolveTarget(config, options.target);

  const ownLogger = logger ?? createLogger("pr-create");

  try {
    const prBodyOptions: PrBodyOptions = {
      body: options.body,
      bodyFile: options.bodyFile,
      issue: options.issue,
    };

    const renderedBody = await buildPrBody({
      defaultBody: DEFAULT_MANUAL_PR_BODY,
      options: prBodyOptions,
    });

    if (!prProvider) {
      throw new Error("PR provider is required to create a pull request");
    }

    const workflowResult = await runPrWorkflow({
      target,
      explicitBase: options.base,
      explicitHead: options.head,
      logger: ownLogger,
      title: options.title,
      body: renderedBody,
      prProvider,
      repoRoot: repoRoot ?? "",
    });

    return {
      config,
      target,
      options,
      renderedBody,
      baseBranch: workflowResult.baseBranch,
      currentBranch: workflowResult.currentBranch,
      prNumber: workflowResult.prNumber,
      prUrl: workflowResult.prUrl,
    };
  } finally {
    if (!logger) {
      await ownLogger.close();
    }
  }
}

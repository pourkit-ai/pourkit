import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync, execFile } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";

vi.mock("@clack/prompts", () => ({
  select,
  confirm,
  text,
  isCancel,
  log: logMock,
}));

import type { GitHubClient } from "../providers/github-client";

import {
  DEFAULT_RUNNER_LABELS,
  InitPlan,
  NO_TOKEN_LABEL_PROVISIONING_WARNING,
  RunnerLabelsConfig,
  applyInitFromSource,
  applyInitPlan,
  detectPackageManager,
  discoverLocalSource,
  generateConfigTemplate,
  generateTriageLabelsDoc,
  inferVerificationCommands,
  planInit,
  promptForInitChoices,
  renderInitPlan,
  renderInitPlanJson,
  runInitCommand,
  writeManifest,
} from "./init";

const { select, confirm, text, isCancel, logMock } = vi.hoisted(() => {
  const select = vi.fn();
  const confirm = vi.fn();
  const text = vi.fn();
  const isCancel = vi.fn(() => false);
  const logMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  };
  return { select, confirm, text, isCancel, logMock };
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pourkit-init-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withGitRepo<T>(
  dir: string,
  fn: (repoDir: string) => Promise<T>
): Promise<T> {
  execFileSync("git", ["-c", "init.defaultBranch=master", "init"], {
    cwd: dir,
    encoding: "utf8",
  });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: dir,
    encoding: "utf8",
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: dir,
    encoding: "utf8",
  });
  await writeFile(path.join(dir, "README.md"), "# test", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: dir,
    encoding: "utf8",
  });
  return await fn(dir);
}

async function writeDefaultSandboxDockerfile(root: string): Promise<void> {
  await mkdir(path.join(root, ".sandcastle"), { recursive: true });
  await writeFile(
    path.join(root, ".sandcastle", "Dockerfile"),
    [
      "FROM node:22-trixie",
      "RUN mkdir -p /home/agent/.cache && chown agent:node /home/agent/.cache",
      "",
    ].join("\n"),
    "utf-8"
  );
}

describe("detectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(dir)).toBe("pnpm");
    });
  });

  it("detects yarn from yarn.lock", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "yarn.lock"), "");
      expect(detectPackageManager(dir)).toBe("yarn");
    });
  });

  it("detects bun from bun.lock", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "bun.lock"), "");
      expect(detectPackageManager(dir)).toBe("bun");
    });
  });

  it("detects npm from package-lock.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "package-lock.json"), "");
      expect(detectPackageManager(dir)).toBe("npm");
    });
  });

  it("returns null for a directory with no lockfiles", async () => {
    await withTempDir(async (dir) => {
      expect(detectPackageManager(dir)).toBeNull();
    });
  });

  it("prioritizes pnpm when multiple lockfiles exist", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
      await writeFile(path.join(dir, "package-lock.json"), "");
      expect(detectPackageManager(dir)).toBe("pnpm");
    });
  });
});

describe("discoverLocalSource", () => {
  it("records branch, SHA, and non-dirty state for a clean repo", async () => {
    await withTempDir(async (dir) => {
      await withGitRepo(dir, async () => {
        const metadata = await discoverLocalSource(dir);
        expect(metadata.versionSource).toBe("local-git");
        expect(metadata.sourceDirty).toBe(false);
        expect(metadata.branch).toBe("master");
        expect(metadata.releaseChannel).toBe("stable");
        expect(metadata.sha).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  it("records dirty state when uncommitted changes exist", async () => {
    await withTempDir(async (dir) => {
      await withGitRepo(dir, async () => {
        await writeFile(path.join(dir, "dirty.txt"), "dirty content");
        const metadata = await discoverLocalSource(dir);
        expect(metadata).toMatchObject({
          versionSource: "local-git",
          sourceDirty: true,
          releaseChannel: "stable",
        });
      });
    });
  });

  it("records the latest matching tag when one exists", async () => {
    await withTempDir(async (dir) => {
      await withGitRepo(dir, async () => {
        execFileSync("git", ["tag", "v1.0.0"], {
          cwd: dir,
          encoding: "utf8",
        });
        const metadata = await discoverLocalSource(dir);
        expect(metadata.latestTag).toBe("v1.0.0");
      });
    });
  });

  it("sets latestTag to null when no tags match", async () => {
    await withTempDir(async (dir) => {
      await withGitRepo(dir, async () => {
        const metadata = await discoverLocalSource(dir);
        expect(metadata.latestTag).toBeNull();
      });
    });
  });

  it("records development release channel for non-main branches", async () => {
    await withTempDir(async (dir) => {
      await withGitRepo(dir, async () => {
        execFileSync("git", ["checkout", "-q", "-b", "feature/test"], {
          cwd: dir,
          encoding: "utf8",
        });
        const metadata = await discoverLocalSource(dir);
        expect(metadata.releaseChannel).toBe("development");
        expect(metadata.branch).toBe("feature/test");
      });
    });
  });
});

describe("planInit", () => {
  it("performs dry-run planning with no writes", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".pourkit"), { recursive: true });
      await writeFile(path.join(targetRoot, "package.json"), "{}");
      await writeFile(path.join(targetRoot, "pnpm-lock.yaml"), "");

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({
            targetRoot,
            sourceRoot,
          });

          expect(plan.operations.some((op) => op.kind === "create")).toBe(true);
          expect(plan.operations.some((op) => op.kind === "copy")).toBe(true);
          expect(
            existsSync(path.join(targetRoot, ".pourkit", "manifest.json"))
          ).toBe(false);

          expect(plan.targetRoot).toBe(targetRoot);
          expect(plan.sourceRoot).toBe(sourceRoot);
          expect(Array.isArray(plan.operations)).toBe(true);
          expect(Array.isArray(plan.warnings)).toBe(true);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("includes skip operation for detected package manager", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "yarn.lock"), "");
      const plan = await planInit({ targetRoot: dir });
      expect(plan.operations.some((op) => op.kind === "skip")).toBe(true);
    });
  });

  it("reports warning when no --from-local source is provided", async () => {
    await withTempDir(async (dir) => {
      const plan = await planInit({ targetRoot: dir });
      expect(plan.warnings.some((w) => w.includes("--from-local"))).toBe(true);
    });
  });

  it("reports warning when target is not a git repo", async () => {
    await withTempDir(async (dir) => {
      const plan = await planInit({ targetRoot: dir });
      expect(plan.warnings.some((w) => w.toLowerCase().includes("git"))).toBe(
        true
      );
    });
  });

  it("reports warning when target git repo has no GitHub remote", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await withGitRepo(targetRoot, async () => {
            const plan = await planInit({
              targetRoot,
              sourceRoot,
            });
            expect(
              plan.warnings.some((w) =>
                w.toLowerCase().includes("github remote")
              )
            ).toBe(true);
          });
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("records warning for non-Git source without throwing", async () => {
    await withTempDir(async (targetRoot) => {
      const nonGitSource = await mkdtemp(
        path.join(tmpdir(), "pourkit-nongit-source-")
      );
      try {
        const plan = await planInit({
          targetRoot,
          sourceRoot: nonGitSource,
        });
        expect(
          plan.warnings.some((w) => w.toLowerCase().includes("not a git"))
        ).toBe(true);
        expect(plan.operations.some((op) => op.kind === "create")).toBe(true);
      } finally {
        await rm(nonGitSource, { recursive: true, force: true });
      }
    });
  });

  it("reports warning for dirty local source", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await writeFile(path.join(sourceRoot, "dirty.txt"), "dirty");
          const plan = await planInit({
            targetRoot,
            sourceRoot,
          });
          expect(
            plan.warnings.some((w) => w.toLowerCase().includes("uncommitted"))
          ).toBe(true);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("skips existing agent files when no sourceRoot", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "AGENTS.md"), "# agents");
      await writeFile(path.join(dir, "CLAUDE.md"), "# claude");
      const plan = await planInit({ targetRoot: dir });
      const agentSkips = plan.operations.filter(
        (op) =>
          op.kind === "skip" &&
          ["AGENTS.md", "CLAUDE.md"].includes(path.basename(op.path ?? ""))
      );
      expect(agentSkips).toHaveLength(2);
    });
  });

  it("emits update for existing AGENTS.md when sourceRoot is provided", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "AGENTS.md"),
        "# My Agent Config\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });

          const updateOps = plan.operations.filter(
            (op) => op.kind === "update" && op.path?.endsWith("AGENTS.md")
          );
          expect(updateOps).toHaveLength(1);
          expect(updateOps[0].content).toContain("## Agent Skills");
          expect(updateOps[0].ownership).toBe("managed");

          expect(
            plan.operations.some(
              (op) => op.kind === "create" && op.path?.endsWith("AGENTS.md")
            )
          ).toBe(false);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("creates AGENTS.md when agentFile is 'agents' and only CLAUDE.md exists", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(path.join(targetRoot, "CLAUDE.md"), "# claude config\n");
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({
            targetRoot,
            sourceRoot,
            conflictPolicy: {
              docsMigration: "skip",
              agentFile: "agents",
              yes: true,
            },
          });

          const agentsCreate = plan.operations.find(
            (op) => op.kind === "create" && op.path?.endsWith("AGENTS.md")
          );
          expect(agentsCreate).toBeDefined();
          expect(agentsCreate!.ownership).toBe("managed");

          const claudeSkip = plan.operations.find(
            (op) => op.kind === "skip" && op.path?.endsWith("CLAUDE.md")
          );
          expect(claudeSkip).toBeDefined();
          expect(claudeSkip!.ownership).toBe("project-owned");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("creates CLAUDE.md when agentFile is 'claude' and only AGENTS.md exists", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(path.join(targetRoot, "AGENTS.md"), "# agents config\n");
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({
            targetRoot,
            sourceRoot,
            conflictPolicy: {
              docsMigration: "skip",
              agentFile: "claude",
              yes: true,
            },
          });

          const claudeCreate = plan.operations.find(
            (op) => op.kind === "create" && op.path?.endsWith("CLAUDE.md")
          );
          expect(claudeCreate).toBeDefined();
          expect(claudeCreate!.ownership).toBe("managed");

          const agentsSkip = plan.operations.find(
            (op) => op.kind === "skip" && op.path?.endsWith("AGENTS.md")
          );
          expect(agentsSkip).toBeDefined();
          expect(agentsSkip!.ownership).toBe("project-owned");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("emits update for existing .gitignore when sourceRoot is provided", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(path.join(targetRoot, ".gitignore"), "node_modules/\n");
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });

          const updateOps = plan.operations.filter(
            (op) => op.kind === "update" && op.path?.endsWith(".gitignore")
          );
          expect(updateOps).toHaveLength(1);
          expect(updateOps[0].content).toContain(".pourkit/logs/");
          expect(updateOps[0].ownership).toBe("managed");

          expect(
            plan.operations.some(
              (op) => op.kind === "create" && op.path?.endsWith(".gitignore")
            )
          ).toBe(false);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("discovers .agents/skills and .opencode/skills directories", async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, ".agents", "skills"), { recursive: true });
      await mkdir(path.join(dir, ".opencode", "skills"), {
        recursive: true,
      });
      const plan = await planInit({ targetRoot: dir });
      const skillSkips = plan.operations.filter(
        (op) => op.kind === "skip" && op.reason.includes("skill")
      );
      expect(skillSkips).toHaveLength(2);
    });
  });

  it("generates managed AGENTS.md instead of copying from source", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await writeFile(
            path.join(sourceRoot, "AGENTS.md"),
            "# agents",
            "utf-8"
          );
          await writeFile(
            path.join(sourceRoot, "CLAUDE.md"),
            "# claude",
            "utf-8"
          );
          await mkdir(path.join(sourceRoot, ".agents", "skills", "to-prd"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".agents", "skills", "to-prd", "SKILL.md"),
            "# to-prd"
          );

          const plan = await planInit({ targetRoot, sourceRoot });
          // Agent files from source are NOT copied; AGENTS.md is generated as managed
          const agentCopies = plan.operations.filter(
            (op) =>
              op.kind === "copy" &&
              (op.path?.endsWith("AGENTS.md") || op.path?.endsWith("CLAUDE.md"))
          );
          expect(agentCopies).toHaveLength(0);
          // AGENTS.md is generated as a managed create operation
          const agentsCreate = plan.operations.find(
            (op) => op.kind === "create" && op.path?.endsWith("AGENTS.md")
          );
          expect(agentsCreate).toBeDefined();
          expect(agentsCreate!.ownership).toBe("managed");
          // Skills from source are still copied
          const skillCopies = plan.operations.filter(
            (op) => op.kind === "copy" && op.reason.includes("skill")
          );
          expect(skillCopies).toHaveLength(1);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("emits skip for existing .pourkit/manifest.json instead of create", async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, ".pourkit"), { recursive: true });
      await writeFile(path.join(dir, ".pourkit", "manifest.json"), "{}");
      const plan = await planInit({
        targetRoot: dir,
        sourceRoot: dir,
      });
      const manifestOps = plan.operations.filter((op) =>
        op.path?.endsWith("manifest.json")
      );
      expect(manifestOps).toHaveLength(1);
      expect(manifestOps[0].kind).toBe("skip");
      expect(manifestOps[0].conflict).toBe("already exists");
      expect(
        plan.operations.some(
          (op) => op.kind === "create" && op.path?.endsWith("manifest.json")
        )
      ).toBe(false);
    });
  });

  it("emits warn operations for discovery warnings", async () => {
    await withTempDir(async (dir) => {
      const plan = await planInit({ targetRoot: dir });
      const warnOps = plan.operations.filter((op) => op.kind === "warn");
      expect(warnOps.length).toBeGreaterThanOrEqual(1);
      const missingSourceWarn = warnOps.find(
        (op) => op.reason === "No --from-local source provided"
      );
      expect(missingSourceWarn).toBeDefined();
      expect(missingSourceWarn!.destructive).toBe(false);
      expect(missingSourceWarn!.requiresConfirmation).toBe(false);
    });
  });

  it("reports warning and skips copy operations for nonexistent --from-local path", async () => {
    await withTempDir(async (targetRoot) => {
      const nonexistent = "/nonexistent/path/for/init";
      const plan = await planInit({
        targetRoot,
        sourceRoot: nonexistent,
      });
      expect(plan.warnings.some((w) => w.includes("does not exist"))).toBe(
        true
      );
      expect(plan.operations.some((op) => op.kind === "copy")).toBe(false);
    });
  });

  it("copies source skills even when target .agents/skills already exists", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".agents", "skills", "existing"), {
        recursive: true,
      });
      await writeFile(
        path.join(targetRoot, ".agents", "skills", "existing", "SKILL.md"),
        "# existing\n"
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".agents", "skills", "to-prd"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".agents", "skills", "to-prd", "SKILL.md"),
            "# to-prd\n"
          );

          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          expect(
            existsSync(
              path.join(targetRoot, ".agents", "skills", "to-prd", "SKILL.md")
            )
          ).toBe(true);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("plans complete fresh-repo bootstrap assets", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".agents", "skills", "to-prd"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".agents", "skills", "to-prd", "SKILL.md"),
            "# to-prd"
          );
          await mkdir(path.join(sourceRoot, ".pourkit", "docs", "agents"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".pourkit", "docs", "agents", "domain.md"),
            "# domain"
          );
          await mkdir(path.join(sourceRoot, ".pourkit", "prompts"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".pourkit", "prompts", "builder.prompt.md"),
            "# builder"
          );
          await writeDefaultSandboxDockerfile(sourceRoot);
          const rootAgentsContent = readFileSync(
            path.join(process.cwd(), "AGENTS.md"),
            "utf-8"
          );
          await writeFile(
            path.join(sourceRoot, "AGENTS.md"),
            rootAgentsContent
          );

          const plan = await planInit({ targetRoot, sourceRoot });

          const opPaths = plan.operations
            .filter((op) => op.path)
            .map((op) => path.relative(targetRoot, op.path!));

          // All required asset paths
          expect(opPaths).toContain(path.join(".pourkit", "CONTEXT.md"));
          expect(opPaths).toContain(
            path.join(".pourkit", "docs", "adr", ".gitkeep")
          );
          expect(opPaths).toContain(path.join("pourkit.config.ts"));
          expect(opPaths).toContain(path.join("AGENTS.md"));
          expect(opPaths).toContain(path.join("opencode.json"));
          expect(opPaths).toContain(path.join(".gitignore"));
          expect(opPaths).toContain(
            path.join(".agents", "skills", "to-prd", "SKILL.md")
          );
          expect(opPaths).toContain(
            path.join(".pourkit", "docs", "agents", "domain.md")
          );
          expect(opPaths).toContain(
            path.join(".pourkit", "prompts", "builder.prompt.md")
          );
          expect(opPaths).toContain(path.join(".sandcastle", "Dockerfile"));

          // Ownership modes on copy operations
          const skillCopies = plan.operations.filter(
            (op) =>
              op.kind === "copy" &&
              op.ownership === "copied-customizable" &&
              op.reason.startsWith("Copy skill")
          );
          expect(skillCopies.length).toBeGreaterThanOrEqual(1);
          expect(skillCopies.some((op) => op.path?.includes("ast-grep"))).toBe(
            false
          );
          const managedCopies = plan.operations.filter(
            (op) =>
              op.kind === "copy" &&
              op.ownership === "managed" &&
              (op.reason.startsWith("Copy agent doc") ||
                op.reason.startsWith("Copy prompt") ||
                op.reason.startsWith("Copy default Sandcastle Dockerfile"))
          );
          expect(managedCopies.length).toBeGreaterThanOrEqual(2);

          // Checksums on copied assets
          const copyOpsWithChecksum = plan.operations.filter(
            (op) => op.kind === "copy" && op.checksum !== undefined
          );
          expect(copyOpsWithChecksum.length).toBeGreaterThanOrEqual(3);
          for (const op of copyOpsWithChecksum) {
            expect(op.checksum).toMatch(/^[0-9a-f]{64}$/);
          }

          // Generated content: pourkit.config.ts
          const configOp = plan.operations.find(
            (op) =>
              op.kind === "create" && op.path?.endsWith("pourkit.config.ts")
          );
          expect(configOp?.content).toContain("autoMerge: false");
          expect(configOp?.content).toContain(
            ".pourkit/prompts/builder.prompt.md"
          );
          expect(configOp?.content).toContain('agent: "pourkit-builder"');
          expect(configOp?.content).toContain('agent: "pourkit-reviewer"');
          expect(configOp?.content).toContain('agent: "pourkit-refactor"');
          expect(configOp?.content).toContain(
            'agent: "pourkit-pr-description"'
          );
          expect(configOp?.content).not.toContain('baseBranch: "next"');

          // Regression: existing OpenCode mounts unchanged
          expect(configOp?.content).toContain(
            'hostPath: "~/.local/share/opencode"'
          );
          expect(configOp?.content).toContain(
            'sandboxPath: "/home/agent/.local/share/opencode"'
          );
          expect(configOp?.content).toContain(
            'hostPath: "~/.local/share/opencode",' +
              '\n        sandboxPath: "/home/agent/.local/share/opencode",' +
              "\n        readonly: false,"
          );
          expect(configOp?.content).toContain('hostPath: "~/.config/opencode"');
          expect(configOp?.content).toContain("readonly: true");

          // Generated content: CONTEXT.md
          const contextOp = plan.operations.find(
            (op) =>
              op.kind === "create" &&
              op.path?.endsWith(path.join(".pourkit", "CONTEXT.md"))
          );
          expect(contextOp?.content).toContain("## Language");
          expect(contextOp?.content).toContain("## Example Dialogue");
          expect(contextOp?.content).toContain("## Flagged Ambiguities");

          // Generated content: AGENTS.md
          const agentsOp = plan.operations.find(
            (op) => op.kind === "create" && op.path?.endsWith("AGENTS.md")
          );
          expect(agentsOp?.content).toContain("## Agent Skills");
          expect(agentsOp?.content).toContain("## Codebase exploration");
          expect(agentsOp?.content).toContain(".agents/skills");
          expect(agentsOp?.content).toContain(".pourkit/docs/agents");
          expect(agentsOp?.content).toContain(
            "<!-- BEGIN POURKIT MANAGED BLOCK -->"
          );
          expect(agentsOp?.content).toContain(
            ".pourkit/docs/agents/issue-tracker.md"
          );
          expect(agentsOp?.content).toContain(
            "This project uses Code Context Engine for intelligent code retrieval and"
          );
          expect(agentsOp?.content).toContain("context_search");
          expect(agentsOp?.content).toContain("session_recall");

          // Generated content: .gitignore
          const gitignoreOp = plan.operations.find(
            (op) => op.kind === "create" && op.path?.endsWith(".gitignore")
          );
          expect(gitignoreOp?.content).toContain(".pourkit/logs/");
          expect(gitignoreOp?.content).toContain(".pourkit/.tmp/");
          expect(gitignoreOp?.content).toContain(".pourkit/state.json");
          expect(gitignoreOp?.content).toContain(".sandcastle/worktrees/");
          expect(gitignoreOp?.content).toContain(".sandcastle/logs/");

          // Generated content: opencode.json
          const openCodeOp = plan.operations.find(
            (op) => op.kind === "create" && op.path?.endsWith("opencode.json")
          );
          const openCodeConfig = JSON.parse(openCodeOp?.content ?? "{}");
          expect(openCodeConfig.$schema).toBe(
            "https://opencode.ai/config.json"
          );
          expect(openCodeConfig.agent["pourkit-builder"].mode).toBe("primary");
          expect(openCodeConfig.agent["pourkit-reviewer"].permission.task).toBe(
            "deny"
          );
          expect(
            openCodeConfig.agent["pourkit-refactor"].permission.task
          ).toEqual({
            "*": "deny",
            "advisory-analyzer": "allow",
          });
          expect(openCodeConfig.agent["pourkit-pr-description"].mode).toBe(
            "primary"
          );
          expect(openCodeConfig.agent["advisory-analyzer"]).toMatchObject({
            mode: "subagent",
            hidden: true,
            prompt: "{file:.pourkit/prompts/advisory-analyzer.prompt.md}",
          });

          // Managed content: default Sandcastle Dockerfile
          const sandboxDockerfileOp = plan.operations.find(
            (op) =>
              op.kind === "copy" &&
              op.path?.endsWith(path.join(".sandcastle", "Dockerfile"))
          );
          expect(sandboxDockerfileOp?.ownership).toBe("managed");
          expect(sandboxDockerfileOp?.checksum).toMatch(/^[0-9a-f]{64}$/);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("warns on malformed existing opencode.json and does not overwrite", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "opencode.json"),
        "{ nope",
        "utf-8"
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });

          expect(
            plan.operations.some(
              (op) => op.kind === "create" && op.path?.endsWith("opencode.json")
            )
          ).toBe(false);
          expect(plan.warnings).toContain(
            "Existing opencode.json is malformed; skipping"
          );
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("warns and skips when existing opencode.json is not a config object", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(path.join(targetRoot, "opencode.json"), "[]", "utf-8");

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });

          expect(
            plan.operations.some(
              (op) => op.kind === "create" && op.path?.endsWith("opencode.json")
            )
          ).toBe(false);
          expect(plan.warnings).toContain(
            "Existing opencode.json is not a valid config object; skipping"
          );
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("preserves existing opencode.json when schema is already present", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        "utf-8"
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });
          const openCodeOp = plan.operations.find((op) =>
            op.path?.endsWith("opencode.json")
          );

          expect(openCodeOp).toMatchObject({
            kind: "skip",
            ownership: "project-owned",
            reason: "Existing opencode.json config",
          });
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("adds schema to existing opencode.json while preserving unrelated fields", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "opencode.json"),
        JSON.stringify({ theme: "system" }),
        "utf-8"
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });
          const openCodeOp = plan.operations.find(
            (op) => op.kind === "create" && op.path?.endsWith("opencode.json")
          );
          const mergedConfig = JSON.parse(openCodeOp?.content ?? "{}");

          expect(openCodeOp).toMatchObject({
            ownership: "managed",
            reason: "Update opencode.json with schema",
            destructive: true,
          });
          expect(mergedConfig).toEqual({
            $schema: "https://opencode.ai/config.json",
            agent: expect.objectContaining({
              "advisory-analyzer": expect.objectContaining({ hidden: true }),
              "pourkit-builder": expect.objectContaining({ mode: "primary" }),
            }),
            theme: "system",
          });
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("plans readme copy when source has readme but target does not", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });
          const readmeCopies = plan.operations.filter(
            (op) => op.kind === "copy" && op.path?.endsWith("README.md")
          );
          expect(readmeCopies).toHaveLength(1);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("skips an existing project-owned Sandcastle Dockerfile", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".sandcastle"), { recursive: true });
      await writeFile(
        path.join(targetRoot, ".sandcastle", "Dockerfile"),
        "FROM custom:latest\n"
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await writeDefaultSandboxDockerfile(sourceRoot);

          const plan = await planInit({ targetRoot, sourceRoot });
          const sandboxOps = plan.operations.filter((op) =>
            op.path?.endsWith(path.join(".sandcastle", "Dockerfile"))
          );

          expect(sandboxOps).toHaveLength(1);
          expect(sandboxOps[0]).toMatchObject({
            kind: "skip",
            ownership: "project-owned",
          });
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("generates triage labels doc with custom runner labels when provided", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".pourkit", "docs", "agents"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".pourkit", "docs", "agents", "domain.md"),
            "# domain"
          );
          await writeFile(
            path.join(
              sourceRoot,
              ".pourkit",
              "docs",
              "agents",
              "triage-labels.md"
            ),
            "# old content"
          );

          const customLabels: RunnerLabelsConfig = {
            readyForAgent: "custom-ready",
            agentInProgress: "custom-in-progress",
            blocked: "custom-blocked",
            prOpenAwaitingMerge: "custom-pr-merge",
            readyForHuman: "custom-human",
          };

          const plan = await planInit({
            targetRoot,
            sourceRoot,
            labels: customLabels,
          });

          const triageOp = plan.operations.find(
            (op) =>
              op.kind === "create" && op.path?.endsWith("triage-labels.md")
          );
          expect(triageOp).toBeDefined();
          expect(triageOp!.content).toContain("custom-ready");
          expect(triageOp!.content).toContain("custom-in-progress");
          expect(triageOp!.content).toContain("custom-blocked");
          expect(triageOp!.content).toContain("custom-pr-merge");
          expect(triageOp!.content).toContain("custom-human");
          expect(triageOp!.ownership).toBe("managed");

          const domainCopy = plan.operations.find(
            (op) => op.kind === "copy" && op.path?.endsWith("domain.md")
          );
          expect(domainCopy).toBeDefined();
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("plans canonical label provisioning when GitHub remote exists", async () => {
    await withTempDir(async (targetRoot) => {
      await withGitRepo(targetRoot, async () => {
        execFileSync(
          "git",
          ["remote", "add", "origin", "https://github.com/owner/repo.git"],
          { cwd: targetRoot }
        );

        const plan = await planInit({
          targetRoot,
        });

        const labelOps = plan.operations.filter(
          (op) => op.kind === "provision-label"
        );
        expect(labelOps.length).toBeGreaterThan(0);

        const labelNames = labelOps.map((op) => op.labelName);
        expect(labelNames).toContain("ready-for-agent");
        expect(labelNames).toContain("needs-triage");
      });
    });
  });

  it("root AGENTS.md references canonical Pourkit agent doc paths", () => {
    const root = process.cwd();
    const content = readFileSync(path.join(root, "AGENTS.md"), "utf-8");
    expect(content).toContain(".pourkit/docs/agents/issue-tracker.md");
    expect(content).toContain(".pourkit/docs/agents/triage-labels.md");
    expect(content).toContain(".pourkit/docs/agents/naming.md");
    expect(content).not.toMatch(/for this project\./);
  });

  it("prompt files copied during init do not contain npm-specific verification commands", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".pourkit", "prompts"), {
            recursive: true,
          });
          const repoPromptsDir = path.join(
            process.cwd(),
            ".pourkit",
            "prompts"
          );
          for (const name of ["builder.prompt.md", "refactor.prompt.md"]) {
            const content = readFileSync(
              path.join(repoPromptsDir, name),
              "utf-8"
            );
            await writeFile(
              path.join(sourceRoot, ".pourkit", "prompts", name),
              content
            );
          }

          const plan = await planInit({ targetRoot, sourceRoot });

          const promptCopies = plan.operations.filter(
            (op) => op.kind === "copy" && op.reason?.startsWith("Copy prompt")
          );
          expect(promptCopies.length).toBeGreaterThanOrEqual(2);

          for (const op of promptCopies) {
            const content = readFileSync(op.sourcePath!, "utf-8");
            expect(content).not.toContain("npm run build:agent");
            expect(content).not.toContain("npm run test:agent");
          }
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("existing repo init", () => {
  it("copies root domain docs by default", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "CONTEXT.md"),
        "# Original Context\n"
      );
      await writeFile(
        path.join(targetRoot, "CONTEXT-MAP.md"),
        "# CONTEXT-MAP\n"
      );
      await mkdir(path.join(targetRoot, "docs", "adr"), { recursive: true });
      await writeFile(
        path.join(targetRoot, "docs", "adr", "0001-existing.md"),
        "# ADR 1\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);

          expect(existsSync(path.join(targetRoot, "CONTEXT.md"))).toBe(true);
          expect(
            existsSync(path.join(targetRoot, ".pourkit", "CONTEXT.md"))
          ).toBe(true);

          const manifestContent = readFileSync(
            path.join(targetRoot, ".pourkit", "manifest.json"),
            "utf-8"
          );
          const manifest = JSON.parse(manifestContent);
          expect(manifest.assets[".pourkit/CONTEXT.md"].ownership).toBe(
            "project-owned"
          );
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("moves root domain docs only with explicit move and yes", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "CONTEXT.md"),
        "# Original Context\n"
      );
      await writeFile(
        path.join(targetRoot, "CONTEXT-MAP.md"),
        "# CONTEXT-MAP\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({
            targetRoot,
            sourceRoot,
            conflictPolicy: {
              docsMigration: "move",
              agentFile: "both",
              yes: true,
            },
          });
          const result = await applyInitPlan(plan);

          expect(result.errors).toHaveLength(0);

          expect(existsSync(path.join(targetRoot, "CONTEXT.md"))).toBe(false);
          expect(
            existsSync(path.join(targetRoot, ".pourkit", "CONTEXT.md"))
          ).toBe(true);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("does not move root docs without yes", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "CONTEXT.md"),
        "# Original Context\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({
            targetRoot,
            sourceRoot,
            conflictPolicy: {
              docsMigration: "move",
              agentFile: "both",
              yes: false,
            },
          });

          const moveOps = plan.operations.filter((op) => op.kind === "move");
          expect(moveOps).toHaveLength(0);

          const copyOps = plan.operations.filter(
            (op) =>
              op.kind === "copy" &&
              op.path?.includes(".pourkit") &&
              op.path?.endsWith("CONTEXT.md")
          );
          expect(copyOps).toHaveLength(1);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("copies legacy opencode skills only when selected", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".opencode", "skills", "custom"), {
        recursive: true,
      });
      await writeFile(
        path.join(targetRoot, ".opencode", "skills", "custom", "SKILL.md"),
        "# Custom Skill\n"
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({
            targetRoot,
            sourceRoot,
            legacySkills: true,
          });

          const result = await applyInitPlan(plan);
          expect(result.errors).toHaveLength(0);

          expect(
            existsSync(
              path.join(targetRoot, ".agents", "skills", "custom", "SKILL.md")
            )
          ).toBe(true);
          expect(
            existsSync(
              path.join(targetRoot, ".opencode", "skills", "custom", "SKILL.md")
            )
          ).toBe(true);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("legacy opencode skills are not copied by default", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".opencode", "skills", "custom"), {
        recursive: true,
      });
      await writeFile(
        path.join(targetRoot, ".opencode", "skills", "custom", "SKILL.md"),
        "# Custom Skill\n"
      );

      const plan = await planInit({ targetRoot });

      const legacyCopies = plan.operations.filter(
        (op) =>
          op.kind === "copy" && op.reason.startsWith("Migrate legacy skill")
      );
      expect(legacyCopies).toHaveLength(0);
    });
  });

  it("existing pourkit config is skipped by default", async () => {
    await withTempDir(async (targetRoot) => {
      const configPath = path.join(targetRoot, "pourkit.config.ts");
      await writeFile(configPath, "// sentinel existing config\n");

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({ targetRoot, sourceRoot });

          const configOps = plan.operations.filter(
            (op) => op.path === configPath
          );
          expect(configOps).toHaveLength(1);
          expect(configOps[0].kind).toBe("skip");
          expect(configOps[0].ownership).toBe("project-owned");

          const result = await applyInitPlan(plan);
          expect(result.errors).toHaveLength(0);
          expect(readFileSync(configPath, "utf-8")).toBe(
            "// sentinel existing config\n"
          );
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("existing project-owned files are skipped or managed-block updated without replacing unrelated content", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "pourkit.config.ts"),
        "// sentinel existing config\n"
      );
      await writeFile(
        path.join(targetRoot, "AGENTS.md"),
        "# project-specific instruction\n"
      );
      await writeFile(path.join(targetRoot, ".gitignore"), "node_modules/\n");
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);

          expect(
            readFileSync(path.join(targetRoot, "pourkit.config.ts"), "utf-8")
          ).toBe("// sentinel existing config\n");

          const agentsContent = readFileSync(
            path.join(targetRoot, "AGENTS.md"),
            "utf-8"
          );
          expect(agentsContent).toContain("project-specific instruction");
          expect(agentsContent).toContain(
            "<!-- BEGIN POURKIT MANAGED BLOCK -->"
          );

          const gitignoreContent = readFileSync(
            path.join(targetRoot, ".gitignore"),
            "utf-8"
          );
          expect(gitignoreContent).toContain("node_modules/");
          expect(gitignoreContent).toContain(
            "<!-- BEGIN POURKIT MANAGED BLOCK -->"
          );
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });
  it("applyInitFromSource moves root domain docs with explicit move and yes", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "CONTEXT.md"),
        "# Original Context\n"
      );
      await writeFile(
        path.join(targetRoot, "CONTEXT-MAP.md"),
        "# CONTEXT-MAP\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
            conflictPolicy: {
              docsMigration: "move",
              agentFile: "both",
              yes: true,
            },
          });

          expect(result.errors).toHaveLength(0);

          expect(existsSync(path.join(targetRoot, "CONTEXT.md"))).toBe(false);
          expect(
            existsSync(path.join(targetRoot, ".pourkit", "CONTEXT.md"))
          ).toBe(true);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("source .opencode/skills is not copied to target .opencode/skills by default", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".opencode", "skills", "custom"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".opencode", "skills", "custom", "SKILL.md"),
            "# Custom Legacy Skill\n"
          );

          const plan = await planInit({ targetRoot, sourceRoot });

          const openCodeCopies = plan.operations.filter(
            (op) => op.kind === "copy" && op.path?.includes(".opencode/skills")
          );
          expect(openCodeCopies).toHaveLength(0);

          const legacySkips = plan.operations.filter(
            (op) => op.kind === "skip" && op.reason.includes(".opencode/skills")
          );
          expect(legacySkips.length).toBeGreaterThanOrEqual(1);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("source .opencode/skills is mapped to .agents/skills when legacy selected", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".opencode", "skills", "custom"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".opencode", "skills", "custom", "SKILL.md"),
            "# Custom Legacy Skill\n"
          );

          const plan = await planInit({
            targetRoot,
            sourceRoot,
            legacySkills: true,
          });

          const legacyMigrations = plan.operations.filter(
            (op) =>
              op.kind === "copy" &&
              op.reason.startsWith("Copy skill") &&
              op.path?.includes(".agents/skills")
          );
          expect(legacyMigrations.length).toBeGreaterThanOrEqual(1);

          const openCodeCopies = plan.operations.filter(
            (op) => op.kind === "copy" && op.path?.includes(".opencode/skills")
          );
          expect(openCodeCopies).toHaveLength(0);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("applyInitFromSource copies legacy opencode skills when selected", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".opencode", "skills", "custom"), {
        recursive: true,
      });
      await writeFile(
        path.join(targetRoot, ".opencode", "skills", "custom", "SKILL.md"),
        "# Custom Skill\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
            legacySkills: true,
          });

          expect(result.errors).toHaveLength(0);

          expect(
            existsSync(
              path.join(targetRoot, ".agents", "skills", "custom", "SKILL.md")
            )
          ).toBe(true);
          expect(
            existsSync(
              path.join(targetRoot, ".opencode", "skills", "custom", "SKILL.md")
            )
          ).toBe(true);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("planned duplicate skill destinations emit skip/conflict instead of duplicate copy", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".opencode", "skills", "shared"), {
        recursive: true,
      });
      await writeFile(
        path.join(targetRoot, ".opencode", "skills", "shared", "SKILL.md"),
        "# Target Legacy Skill\n"
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".agents", "skills", "shared"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".agents", "skills", "shared", "SKILL.md"),
            "# Source Skill\n"
          );

          const plan = await planInit({
            targetRoot,
            sourceRoot,
            legacySkills: true,
          });

          const sharedDest = path.join(
            ".agents",
            "skills",
            "shared",
            "SKILL.md"
          );

          const copyOps = plan.operations.filter(
            (op) => op.kind === "copy" && op.path?.endsWith(sharedDest)
          );
          expect(copyOps).toHaveLength(1);
          expect(copyOps[0].ownership).toBe("project-owned");

          const conflictOps = plan.operations.filter(
            (op) =>
              op.kind === "skip" && op.conflict && op.path?.endsWith(sharedDest)
          );
          expect(conflictOps).toHaveLength(1);

          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
            legacySkills: true,
          });
          expect(result.errors).toHaveLength(0);

          const manifestContent = readFileSync(
            path.join(targetRoot, ".pourkit", "manifest.json"),
            "utf-8"
          );
          const manifest = JSON.parse(manifestContent);
          expect(
            manifest.assets[sharedDest.replace(/\\/g, "/")].ownership
          ).toBe("project-owned");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("renderInitPlan", () => {
  it("renders a grouped human-readable plan", async () => {
    const plan = {
      targetRoot: "/tmp/test",
      sourceRoot: "/tmp/source",
      operations: [
        {
          kind: "skip" as const,
          path: "/tmp/test/README.md",
          reason: "Existing file",
          requiresConfirmation: false,
          destructive: false,
        },
        {
          kind: "copy" as const,
          sourcePath: "/tmp/source",
          path: "/tmp/test",
          reason: "Init from local source",
          requiresConfirmation: true,
          destructive: false,
        },
      ],
      warnings: ["No --from-local source provided"],
    };
    const output = renderInitPlan(plan);
    expect(output).toContain("Skip:");
    expect(output).toContain("Copy:");
    expect(output).toContain("Warnings:");
    expect(output).toContain("2 operation(s), 1 warning(s)");
  });
});

describe("applyInitPlan", () => {
  it("skip operations preserve existing file content", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "pourkit.config.ts");
      await writeFile(configPath, "// sentinel existing config\n");

      const plan: InitPlan = {
        targetRoot: dir,
        sourceRoot: "",
        operations: [
          {
            kind: "skip",
            path: configPath,
            reason: "Existing file skipped",
            requiresConfirmation: false,
            destructive: false,
          },
        ],
        warnings: [],
      };

      const result = await applyInitPlan(plan);

      expect(readFileSync(configPath, "utf-8")).toBe(
        "// sentinel existing config\n"
      );
      expect(result.skipped).toBe(1);
      expect(result.applied).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  it("dry-run remains write-free after apply support", async () => {
    await withTempDir(async (targetRoot) => {
      await mkdir(path.join(targetRoot, ".pourkit"), { recursive: true });
      await writeFile(path.join(targetRoot, "package.json"), "{}");
      await writeFile(path.join(targetRoot, "pnpm-lock.yaml"), "");

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
            dryRun: true,
          });

          expect(result.applied).toBe(0);
          expect(result.manifestWritten).toBe(false);

          expect(
            existsSync(path.join(targetRoot, ".pourkit", "manifest.json"))
          ).toBe(false);
          expect(
            existsSync(path.join(targetRoot, ".pourkit", "CONTEXT.md"))
          ).toBe(false);
          expect(existsSync(path.join(targetRoot, "pourkit.config.ts"))).toBe(
            false
          );
          expect(existsSync(path.join(targetRoot, "AGENTS.md"))).toBe(false);
          expect(existsSync(path.join(targetRoot, ".gitignore"))).toBe(false);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("apply writes manifest last", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".agents", "skills", "to-prd"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".agents", "skills", "to-prd", "SKILL.md"),
            "# to-prd"
          );
          await mkdir(path.join(sourceRoot, ".pourkit", "docs", "agents"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".pourkit", "docs", "agents", "domain.md"),
            "# domain"
          );
          await mkdir(path.join(sourceRoot, ".pourkit", "prompts"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".pourkit", "prompts", "builder.prompt.md"),
            "# builder"
          );
          await writeDefaultSandboxDockerfile(sourceRoot);

          const plan = await planInit({ targetRoot, sourceRoot });
          const sourceMeta = await discoverLocalSource(sourceRoot);

          const result = await applyInitPlan(plan);

          const agentFiles: string[] = [];
          for (const name of ["AGENTS.md", "CLAUDE.md"]) {
            if (existsSync(path.join(targetRoot, name))) {
              agentFiles.push(path.join(targetRoot, name));
            }
          }
          const pm = detectPackageManager(targetRoot);
          await writeManifest(plan, sourceMeta, agentFiles, pm);

          const createdOps = plan.operations.filter(
            (op) =>
              (op.kind === "create" || op.kind === "copy") &&
              op.path &&
              !op.requiresConfirmation
          );
          for (const op of createdOps) {
            expect(existsSync(op.path!)).toBe(true);
          }

          const manifestContent = readFileSync(
            path.join(targetRoot, ".pourkit", "manifest.json"),
            "utf-8"
          );
          expect(manifestContent).toContain("schemaVersion");

          const manifest = JSON.parse(manifestContent);
          expect(manifest.schemaVersion).toBe(1);
          expect(manifest.pourkit).toBeDefined();
          expect(manifest.pourkit.versionSource).toBe("local-git");
          expect(manifest.pourkit.sourceBranch).toBe(sourceMeta.branch);
          expect(manifest.pourkit.sourceGitSha).toBe(sourceMeta.sha);
          expect(Array.isArray(manifest.agentFiles)).toBe(true);
          expect(manifest.assets).toBeDefined();
          expect(manifest.assets[".sandcastle/Dockerfile"]).toBeDefined();
          expect(manifest.assets[".sandcastle/Dockerfile"].ownership).toBe(
            "managed"
          );

          expect(result.applied).toBeGreaterThan(0);
          expect(result.errors).toHaveLength(0);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("applyInitFromSource applies plan and writes manifest", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".agents", "skills", "to-prd"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".agents", "skills", "to-prd", "SKILL.md"),
            "# to-prd"
          );
          await mkdir(path.join(sourceRoot, ".pourkit", "docs", "agents"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".pourkit", "docs", "agents", "domain.md"),
            "# domain"
          );
          await mkdir(path.join(sourceRoot, ".pourkit", "prompts"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".pourkit", "prompts", "builder.prompt.md"),
            "# builder"
          );

          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.applied).toBeGreaterThan(0);
          expect(result.errors).toHaveLength(0);
          expect(result.manifestWritten).toBe(true);

          expect(
            existsSync(path.join(targetRoot, ".pourkit", "manifest.json"))
          ).toBe(true);

          const manifestContent = readFileSync(
            path.join(targetRoot, ".pourkit", "manifest.json"),
            "utf-8"
          );
          expect(manifestContent).toContain("schemaVersion");

          const manifest = JSON.parse(manifestContent);
          expect(manifest.schemaVersion).toBe(1);
          expect(manifest.pourkit).toBeDefined();
          expect(manifest.pourkit.versionSource).toBe("local-git");
          expect(Array.isArray(manifest.agentFiles)).toBe(true);
          expect(manifest.assets).toBeDefined();
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("existing manifest is preserved by applyInitFromSource", async () => {
    await withTempDir(async (targetRoot) => {
      const sentinel = JSON.stringify({ schemaVersion: 0, sentinel: true });
      await mkdir(path.join(targetRoot, ".pourkit"), { recursive: true });
      await writeFile(
        path.join(targetRoot, ".pourkit", "manifest.json"),
        sentinel
      );

      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await mkdir(path.join(sourceRoot, ".agents", "skills", "to-prd"), {
            recursive: true,
          });
          await writeFile(
            path.join(sourceRoot, ".agents", "skills", "to-prd", "SKILL.md"),
            "# to-prd"
          );

          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.manifestWritten).toBe(false);
          const content = readFileSync(
            path.join(targetRoot, ".pourkit", "manifest.json"),
            "utf-8"
          );
          expect(content).toBe(sentinel);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("fresh AGENTS.md includes managed block markers after apply", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          const content = readFileSync(
            path.join(targetRoot, "AGENTS.md"),
            "utf-8"
          );
          expect(content).toContain("<!-- BEGIN POURKIT MANAGED BLOCK -->");
          expect(content).toContain("<!-- END POURKIT MANAGED BLOCK -->");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("fresh .gitignore includes managed block markers after apply", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          const content = readFileSync(
            path.join(targetRoot, ".gitignore"),
            "utf-8"
          );
          expect(content).toContain("<!-- BEGIN POURKIT MANAGED BLOCK -->");
          expect(content).toContain("<!-- END POURKIT MANAGED BLOCK -->");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("existing AGENTS.md with no previous block gets managed block appended", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "AGENTS.md"),
        "# My Agent Config\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const rootAgentsContent = readFileSync(
            path.join(process.cwd(), "AGENTS.md"),
            "utf-8"
          );
          await writeFile(
            path.join(sourceRoot, "AGENTS.md"),
            rootAgentsContent
          );

          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          const content = readFileSync(
            path.join(targetRoot, "AGENTS.md"),
            "utf-8"
          );
          expect(content).toContain("# My Agent Config");
          expect(content).toContain("<!-- BEGIN POURKIT MANAGED BLOCK -->");
          expect(content).toContain("<!-- END POURKIT MANAGED BLOCK -->");
          expect(content).toContain("## Agent Skills");
          expect(content).toContain(".pourkit/docs/agents/triage-labels.md");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("existing .gitignore with no previous block gets managed block appended", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(path.join(targetRoot, ".gitignore"), "node_modules/\n");
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          const content = readFileSync(
            path.join(targetRoot, ".gitignore"),
            "utf-8"
          );
          expect(content).toContain("node_modules/");
          expect(content).toContain("<!-- BEGIN POURKIT MANAGED BLOCK -->");
          expect(content).toContain("<!-- END POURKIT MANAGED BLOCK -->");
          expect(content).toContain(".pourkit/logs/");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("existing managed block in AGENTS.md is replaced after apply", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "AGENTS.md"),
        "# My Agent Config\n<!-- BEGIN POURKIT MANAGED BLOCK -->\nold content\n<!-- END POURKIT MANAGED BLOCK -->\nfooter\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const rootAgentsContent = readFileSync(
            path.join(process.cwd(), "AGENTS.md"),
            "utf-8"
          );
          await writeFile(
            path.join(sourceRoot, "AGENTS.md"),
            rootAgentsContent
          );

          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          const content = readFileSync(
            path.join(targetRoot, "AGENTS.md"),
            "utf-8"
          );
          expect(content).toContain("# My Agent Config");
          expect(content).toContain("footer");
          expect(content).not.toContain("old content");
          expect(content).toContain("## Agent Skills");
          expect(content).toContain(".pourkit/docs/agents/triage-labels.md");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("existing managed block in .gitignore is replaced after apply", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, ".gitignore"),
        "node_modules/\n<!-- BEGIN POURKIT MANAGED BLOCK -->\n.DS_Store\n<!-- END POURKIT MANAGED BLOCK -->\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          const content = readFileSync(
            path.join(targetRoot, ".gitignore"),
            "utf-8"
          );
          expect(content).toContain("node_modules/");
          expect(content).not.toContain(".DS_Store");
          expect(content).toContain(".pourkit/logs/");
          expect(content).toContain("<!-- BEGIN POURKIT MANAGED BLOCK -->");
          expect(content).toContain("<!-- END POURKIT MANAGED BLOCK -->");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("moved root domain docs are recorded in manifest as project-owned", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "CONTEXT.md"),
        "# Original Context\n"
      );
      await writeFile(
        path.join(targetRoot, "CONTEXT-MAP.md"),
        "# CONTEXT-MAP\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const plan = await planInit({
            targetRoot,
            sourceRoot,
            conflictPolicy: {
              docsMigration: "move",
              agentFile: "both",
              yes: true,
            },
          });

          const moveOps = plan.operations.filter((op) => op.kind === "move");
          expect(moveOps.length).toBeGreaterThan(0);

          const result = await applyInitPlan(plan);
          expect(result.errors).toHaveLength(0);

          const sourceMeta = await discoverLocalSource(sourceRoot);
          const agentFiles: string[] = [];
          for (const name of ["AGENTS.md", "CLAUDE.md"]) {
            if (existsSync(path.join(targetRoot, name))) {
              agentFiles.push(path.join(targetRoot, name));
            }
          }
          const pm = detectPackageManager(targetRoot);
          await writeManifest(plan, sourceMeta, agentFiles, pm);

          const manifestPath = path.join(
            targetRoot,
            ".pourkit",
            "manifest.json"
          );
          const manifestContent = readFileSync(manifestPath, "utf-8");
          const manifest = JSON.parse(manifestContent);

          expect(manifest.assets[".pourkit/CONTEXT.md"]).toBeDefined();
          expect(manifest.assets[".pourkit/CONTEXT.md"].ownership).toBe(
            "project-owned"
          );
          expect(typeof manifest.assets[".pourkit/CONTEXT.md"].sha256).toBe(
            "string"
          );
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("existing AGENTS.md update is recorded in manifest with ownership and sha256", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "AGENTS.md"),
        "# My Agent Config\n"
      );
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
          });

          expect(result.errors).toHaveLength(0);
          expect(result.manifestWritten).toBe(true);

          const manifestContent = readFileSync(
            path.join(targetRoot, ".pourkit", "manifest.json"),
            "utf-8"
          );
          const manifest = JSON.parse(manifestContent);
          expect(manifest.assets).toBeDefined();
          expect(manifest.assets["AGENTS.md"]).toBeDefined();
          expect(manifest.assets["AGENTS.md"].ownership).toBe("managed");
          expect(typeof manifest.assets["AGENTS.md"].sha256).toBe("string");
          expect(manifest.assets["AGENTS.md"].sha256).toMatch(/^[a-f0-9]{64}$/);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("preserves an explicit package manager through apply", async () => {
    await withTempDir(async (targetRoot) => {
      await writeFile(
        path.join(targetRoot, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          const result = await applyInitFromSource({
            targetRoot,
            fromLocal: sourceRoot,
            packageManager: "pnpm",
          });

          expect(result.errors).toHaveLength(0);
          const configText = readFileSync(
            path.join(targetRoot, "pourkit.config.ts"),
            "utf-8"
          );
          expect(configText).toContain("pnpm install");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("skips label provisioning without token and emits exact warning", async () => {
    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [
        {
          kind: "provision-label",
          reason: "Provision label: test-label",
          requiresConfirmation: false,
          destructive: false,
          labelName: "test-label",
          labelColor: "#ffffff",
          labelDescription: "test",
        },
      ],
      warnings: [],
    };

    const result = await applyInitPlan(plan, {
      labelConflictPolicy: "skip-metadata-changes",
    });

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toEqual([NO_TOKEN_LABEL_PROVISIONING_WARNING]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("provisions labels via Octokit when token is present", async () => {
    const createLabel = vi.fn().mockResolvedValue({});
    const mockClient: GitHubClient = {
      octokit: {
        rest: { issues: { createLabel } },
      } as unknown as GitHubClient["octokit"],
      owner: "test-owner",
      repo: "test-repo",
    };

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [
        {
          kind: "provision-label",
          reason: "Provision label: test-label",
          requiresConfirmation: false,
          destructive: false,
          labelName: "test-label",
          labelColor: "#ffffff",
          labelDescription: "test",
        },
      ],
      warnings: [],
    };

    const result = await applyInitPlan(plan, {
      labelConflictPolicy: "skip-metadata-changes",
      githubClient: mockClient,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(createLabel).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      name: "test-label",
      color: "ffffff",
      description: "test",
    });
  });

  it("updates existing label via Octokit with update-to-pourkit policy when create fails", async () => {
    const createLabel = vi.fn().mockRejectedValue(new Error("already exists"));
    const updateLabel = vi.fn().mockResolvedValue({});
    const mockClient: GitHubClient = {
      octokit: {
        rest: { issues: { createLabel, updateLabel } },
      } as unknown as GitHubClient["octokit"],
      owner: "test-owner",
      repo: "test-repo",
    };

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [
        {
          kind: "provision-label",
          reason: "Provision label: test-label",
          requiresConfirmation: false,
          destructive: false,
          labelName: "test-label",
          labelColor: "#ffffff",
          labelDescription: "test",
        },
      ],
      warnings: [],
    };

    const result = await applyInitPlan(plan, {
      labelConflictPolicy: "update-to-pourkit",
      githubClient: mockClient,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(createLabel).toHaveBeenCalled();
    expect(updateLabel).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      name: "test-label",
      color: "ffffff",
      description: "test",
    });
    expect(result.warnings[0]).toContain("Updated existing label");
  });

  it("keeps existing label with keep-existing policy when create fails", async () => {
    const createLabel = vi.fn().mockRejectedValue(new Error("already exists"));
    const mockClient: GitHubClient = {
      octokit: {
        rest: { issues: { createLabel } },
      } as unknown as GitHubClient["octokit"],
      owner: "test-owner",
      repo: "test-repo",
    };

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [
        {
          kind: "provision-label",
          reason: "Provision label: test-label",
          requiresConfirmation: false,
          destructive: false,
          labelName: "test-label",
          labelColor: "#ffffff",
          labelDescription: "test",
        },
      ],
      warnings: [],
    };

    const result = await applyInitPlan(plan, {
      labelConflictPolicy: "keep-existing",
      githubClient: mockClient,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(createLabel).toHaveBeenCalled();
    expect(result.warnings[0]).toContain("keeping existing");
  });
});

describe("renderInitPlanJson", () => {
  it("renders a JSON-serialized plan", async () => {
    const plan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [],
      warnings: ["test warning"],
    };
    const output = renderInitPlanJson(plan);
    const parsed = JSON.parse(output);
    expect(parsed.targetRoot).toBe("/tmp/test");
    expect(parsed.warnings).toEqual(["test warning"]);
  });
});

describe("generateConfigTemplate", () => {
  it("generates conservative config template", () => {
    const configText = generateConfigTemplate({
      targetRoot: "/target",
      sourceRoot: "/source",
      packageManager: "npm",
      baseBranch: "main",
      verificationCommands: [
        { label: "typecheck", command: "npm run typecheck" },
        { label: "test:agent", command: "npm run test:agent" },
        { label: "build", command: "npm run build" },
      ],
    });
    expect(configText).toContain("autoMerge: false");
    expect(configText).toContain(".pourkit/prompts/builder.prompt.md");
    expect(configText).not.toContain('baseBranch: "next"');
    expect(configText).toContain("verify: {");
    expect(configText).toContain("commands: [");
    expect(configText).toContain(
      '{ command: "npm run typecheck", label: "typecheck" }'
    );
    expect(configText).not.toContain("verificationCommands");
    expect(configText).toContain(
      'import { definePourkitConfig } from "../source/pourkit/shared/config"'
    );
  });

  it("renders custom runner labels when provided", () => {
    const configText = generateConfigTemplate({
      targetRoot: "/target",
      sourceRoot: "/source",
      packageManager: "npm",
      baseBranch: "main",
      verificationCommands: [],
      labels: {
        readyForAgent: "custom-ready",
        agentInProgress: "custom-in-progress",
        blocked: "custom-blocked",
        prOpenAwaitingMerge: "custom-pr-merge",
        readyForHuman: "custom-human",
      },
    });
    expect(configText).toContain('readyForAgent: "custom-ready"');
    expect(configText).toContain('agentInProgress: "custom-in-progress"');
    expect(configText).toContain('blocked: "custom-blocked"');
    expect(configText).toContain('prOpenAwaitingMerge: "custom-pr-merge"');
    expect(configText).toContain('readyForHuman: "custom-human"');
    expect(configText).not.toContain("needs-triage");
  });

  it("uses default labels when no labels option provided", () => {
    const configText = generateConfigTemplate({
      targetRoot: "/target",
      sourceRoot: "/source",
      packageManager: "npm",
      baseBranch: "main",
      verificationCommands: [],
    });
    expect(configText).toContain(
      'readyForAgent: "' + DEFAULT_RUNNER_LABELS.readyForAgent + '"'
    );
    expect(configText).toContain(
      'blocked: "' + DEFAULT_RUNNER_LABELS.blocked + '"'
    );
  });

  it("omits setup commands when hasPackageJson is false", () => {
    const configText = generateConfigTemplate({
      targetRoot: "/target",
      sourceRoot: "/source",
      packageManager: "npm",
      baseBranch: "main",
      verificationCommands: [],
      hasPackageJson: false,
    });
    expect(configText).not.toContain("setupCommands");
    expect(configText).not.toContain("npm install");
  });
});

describe("inferVerificationCommands", () => {
  it("prefers test:agent over test", () => {
    const commands = inferVerificationCommands(
      {
        test: "vitest run",
        "test:agent": "CI_AGENT=true vitest run",
        build: "tsup",
        typecheck: "tsc --noEmit",
      },
      "npm"
    );
    expect(commands).toContainEqual({
      label: "test:agent",
      command: "npm run test:agent",
    });
    expect(commands).not.toContainEqual({
      label: "test",
      command: "npm run test",
    });
  });
});

describe("promptForInitChoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCancel.mockReturnValue(false);
    text.mockResolvedValue("");
  });

  it("prompts for package manager when lockfile warning exists", async () => {
    select.mockResolvedValue("pnpm");

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "/tmp/source",
      operations: [],
      warnings: ["No package manager lockfile detected"],
    };

    const result = await promptForInitChoices(plan, {});

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("package manager"),
      })
    );
    expect(result.packageManager).toBe("pnpm");
    expect(result.cancelled).toBe(false);
  });

  it("does not prompt for package manager when already provided", async () => {
    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "/tmp/source",
      operations: [],
      warnings: ["No package manager lockfile detected"],
    };

    const result = await promptForInitChoices(plan, {
      packageManager: "npm",
    });

    expect(select).not.toHaveBeenCalled();
    expect(result.packageManager).toBe("npm");
  });

  it("prompts for docs migration when root doc operations exist", async () => {
    select.mockResolvedValue("copy");

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "/tmp/source",
      operations: [
        {
          kind: "copy",
          path: "/tmp/test/.pourkit/CONTEXT.md",
          sourcePath: "/tmp/CONTEXT.md",
          reason: "Copy root domain doc",
          requiresConfirmation: false,
          destructive: false,
        },
      ],
      warnings: [],
    };

    const result = await promptForInitChoices(plan, {});

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("documentation"),
      })
    );
    expect(
      select.mock.calls[0]?.[0].options.map((o: { value: string }) => o.value)
    ).toEqual(["copy", "skip"]);
    expect(result.docsMigration).toBe("copy");
  });

  it("prompts for agent file mode when agent file ops exist", async () => {
    select.mockResolvedValue("agents");

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "/tmp/source",
      operations: [
        {
          kind: "update",
          path: "/tmp/test/AGENTS.md",
          reason: "Update AGENTS.md",
          requiresConfirmation: false,
          destructive: false,
        },
      ],
      warnings: [],
    };

    const result = await promptForInitChoices(plan, {});

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("agent files"),
      })
    );
    expect(result.agentFile).toBe("agents");
  });

  it("returns cancelled when user cancels prompt", async () => {
    isCancel.mockReturnValue(true);

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "/tmp/source",
      operations: [],
      warnings: ["No package manager lockfile detected"],
    };

    const result = await promptForInitChoices(plan, {});

    expect(result.cancelled).toBe(true);
  });

  it("returns safe defaults when no prompts needed", async () => {
    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [],
      warnings: [],
    };

    const result = await promptForInitChoices(plan, {});

    expect(result.cancelled).toBe(false);
    expect(result.docsMigration).toBe("copy");
    expect(result.agentFile).toBe("both");
  });

  it("prompts for runner label names with defaults", async () => {
    text.mockResolvedValue("");

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [],
      warnings: [],
    };

    const result = await promptForInitChoices(plan, {});

    expect(text).toHaveBeenCalledTimes(5);
    expect(result.labels.readyForAgent).toBe(
      DEFAULT_RUNNER_LABELS.readyForAgent
    );
    expect(result.labels.blocked).toBe(DEFAULT_RUNNER_LABELS.blocked);
    expect(result.cancelled).toBe(false);
  });

  it("returns custom label names when user enters them", async () => {
    text
      .mockResolvedValueOnce("custom-ready")
      .mockResolvedValueOnce("custom-in-progress")
      .mockResolvedValueOnce("custom-blocked")
      .mockResolvedValueOnce("custom-pr-merge")
      .mockResolvedValueOnce("custom-human");

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [],
      warnings: [],
    };

    const result = await promptForInitChoices(plan, {});

    expect(result.labels.readyForAgent).toBe("custom-ready");
    expect(result.labels.blocked).toBe("custom-blocked");
    expect(result.labels.readyForHuman).toBe("custom-human");
    expect(result.cancelled).toBe(false);
  });

  it("returns cancelled when label prompt is cancelled", async () => {
    isCancel.mockReturnValue(true);

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [],
      warnings: [],
    };

    const result = await promptForInitChoices(plan, {});

    expect(result.cancelled).toBe(true);
  });

  it("rejects whitespace-only label values and falls back to defaults", async () => {
    text
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("  ")
      .mockResolvedValueOnce(" ")
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("  ");

    const plan: InitPlan = {
      targetRoot: "/tmp/test",
      sourceRoot: "",
      operations: [],
      warnings: [],
    };

    const result = await promptForInitChoices(plan, {});

    expect(result.labels.readyForAgent).toBe(
      DEFAULT_RUNNER_LABELS.readyForAgent
    );
    expect(result.labels.agentInProgress).toBe(
      DEFAULT_RUNNER_LABELS.agentInProgress
    );
    expect(result.labels.blocked).toBe(DEFAULT_RUNNER_LABELS.blocked);
    expect(result.labels.prOpenAwaitingMerge).toBe(
      DEFAULT_RUNNER_LABELS.prOpenAwaitingMerge
    );
    expect(result.labels.readyForHuman).toBe(
      DEFAULT_RUNNER_LABELS.readyForHuman
    );
    expect(result.cancelled).toBe(false);
  });
});

describe("runInitCommand", () => {
  let consoleLogSpy: { mockRestore(): void };
  let consoleErrorSpy: { mockRestore(): void };
  let consoleWarnSpy: { mockRestore(): void };

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("non-TTY succeeds with explicit choices", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await writeFile(
            path.join(targetRoot, "package.json"),
            JSON.stringify({
              name: "test",
              scripts: { test: "vitest run" },
            })
          );
          await writeFile(path.join(targetRoot, "pnpm-lock.yaml"), "");

          await runInitCommand({
            cwd: targetRoot,
            fromLocal: sourceRoot,
            docsMigration: "copy",
            agentFile: "both",
          });

          expect(select).not.toHaveBeenCalled();
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("non-TTY fails with missing required init options", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await expect(
            runInitCommand({
              cwd: targetRoot,
              fromLocal: sourceRoot,
            })
          ).rejects.toThrow("Missing required init options");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("non-TTY fails when docsMigration is move without yes", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await writeFile(path.join(targetRoot, "pnpm-lock.yaml"), "");
          await expect(
            runInitCommand({
              cwd: targetRoot,
              fromLocal: sourceRoot,
              docsMigration: "move",
              agentFile: "both",
            })
          ).rejects.toThrow("--docs-migration move requires --yes.");
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("non-TTY succeeds with --yes using safe defaults", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await writeFile(
            path.join(targetRoot, "package.json"),
            JSON.stringify({
              name: "test",
              scripts: { test: "vitest run" },
            })
          );

          await runInitCommand({
            cwd: targetRoot,
            fromLocal: sourceRoot,
            yes: true,
          });

          expect(text).not.toHaveBeenCalled();

          const configPath = path.join(targetRoot, "pourkit.config.ts");
          expect(existsSync(configPath)).toBe(true);
          const configContent = readFileSync(configPath, "utf-8");
          expect(configContent).toContain(DEFAULT_RUNNER_LABELS.readyForAgent);
          expect(configContent).toContain(
            DEFAULT_RUNNER_LABELS.agentInProgress
          );
          expect(configContent).toContain(DEFAULT_RUNNER_LABELS.blocked);
          expect(configContent).toContain(
            DEFAULT_RUNNER_LABELS.prOpenAwaitingMerge
          );
          expect(configContent).toContain(DEFAULT_RUNNER_LABELS.readyForHuman);
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("passes --cwd to planInit target root", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await writeFile(
            path.join(sourceRoot, "package.json"),
            JSON.stringify({ name: "test" })
          );
          await writeFile(path.join(targetRoot, "pnpm-lock.yaml"), "");

          const result = await runInitCommand({
            cwd: targetRoot,
            fromLocal: sourceRoot,
            dryRun: true,
            docsMigration: "copy",
            agentFile: "both",
            json: true,
          });

          expect(result).toBeUndefined();
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it("prints dry-run note during dry-run", async () => {
    await withTempDir(async (targetRoot) => {
      const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "pourkit-init-source-")
      );
      try {
        await withGitRepo(sourceRoot, async () => {
          await runInitCommand({
            cwd: targetRoot,
            fromLocal: sourceRoot,
            dryRun: true,
            docsMigration: "copy",
            agentFile: "both",
          });

          expect(consoleLogSpy).toHaveBeenCalledWith(
            "\nDry-run — no files were written."
          );
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });
});

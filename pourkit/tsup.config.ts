import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const DEVELOPMENT_VERSION = "0.0.0-development";

function parseChangelogVersion(content: string): string | null {
  const match = content.match(
    /^#\s*\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\]?/m
  );

  return match ? `v${match[1]}` : null;
}

function resolveBuildVersion(): string {
  const configDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(configDir, "..");

  // Use package.json version as the source of truth for npm builds
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(configDir, "package.json"), "utf-8")
    );
    if (pkg.version && pkg.version !== DEVELOPMENT_VERSION) {
      return pkg.version;
    }
  } catch {
    // Fall through to git tag fallback
  }

  try {
    const stdout = execFileSync(
      "git",
      [
        "tag",
        "--list",
        "v[0-9]*",
        "--sort=-version:refname",
        "--merged",
        "HEAD",
      ],
      { cwd: root, encoding: "utf8" }
    );
    const validTag = stdout
      .trim()
      .split("\n")
      .filter((tag) => tag.length > 0)
      .find((tag) =>
        /^v\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(tag)
      );
    if (validTag) {
      return validTag;
    }
  } catch {
    // Fall through to changelog metadata for shallow or tagless checkouts.
  }

  try {
    const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf-8");
    return parseChangelogVersion(changelog) ?? DEVELOPMENT_VERSION;
  } catch {
    return DEVELOPMENT_VERSION;
  }
}

const buildVersion = resolveBuildVersion();

export default defineConfig({
  entry: [
    "cli.ts",
    "e2e/run-live-e2e.ts",
    "issues/unblock.ts",
    "issues/close-issues-on-merge.ts",
  ],
  silent: process.env.CI_AGENT ? true : false,
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  skipNodeModulesBundle: true,
  external: ["pino", "pino-pretty"],
  noExternal: [/^@pourkit\//],
  define: {
    "process.env.POURKIT_CLI_VERSION": JSON.stringify(buildVersion),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});

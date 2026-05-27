import { describe, it, expect, afterEach } from "vitest";
import {
  resolveProfile,
  parseArgs,
  isExecutedAsScript,
  resolveE2EConfigFile,
} from "./run-live-e2e";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function repoRoot(): string {
  return path.resolve(__dirname, "../..");
}

function loadPackageScripts(): Record<string, string> {
  const pkgPath = path.join(repoRoot(), "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  return JSON.parse(raw).scripts;
}

describe("resolveProfile", () => {
  it("returns fast profile when fullCheck is false", () => {
    expect(resolveProfile(false)).toBe("fast");
  });

  it("returns full-check profile when fullCheck is true", () => {
    expect(resolveProfile(true)).toBe("full-check");
  });
});

describe("isExecutedAsScript", () => {
  it("returns true when the current module is the process entrypoint", () => {
    expect(
      isExecutedAsScript(
        "file:///repo/pourkit/dist/e2e/run-live-e2e.js",
        "/repo/pourkit/dist/e2e/run-live-e2e.js"
      )
    ).toBe(true);
  });

  it("returns false when the module is imported by another entrypoint", () => {
    expect(
      isExecutedAsScript(
        "file:///repo/pourkit/dist/e2e/run-live-e2e.js",
        "/repo/pourkit/e2e/run-live-e2e.test.ts"
      )
    ).toBe(false);
  });

  it("returns false when no entrypoint is available", () => {
    expect(
      isExecutedAsScript(
        "file:///repo/pourkit/dist/e2e/run-live-e2e.js",
        undefined
      )
    ).toBe(false);
  });
});

describe("resolveE2EConfigFile", () => {
  const originalConfigFile = process.env.POURKIT_CONFIG_FILE;

  afterEach(() => {
    if (originalConfigFile === undefined) {
      delete process.env.POURKIT_CONFIG_FILE;
    } else {
      process.env.POURKIT_CONFIG_FILE = originalConfigFile;
    }
  });

  it("prefers POURKIT_CONFIG_FILE when set", () => {
    process.env.POURKIT_CONFIG_FILE = "custom.config.ts";
    expect(resolveE2EConfigFile("/repo")).toBe("custom.config.ts");
  });

  it("uses pourkit.config.ts when present", () => {
    const root = path.join(
      repoRoot(),
      "pourkit",
      ".tmp",
      "resolve-e2e-config-file"
    );
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "pourkit.config.ts"),
      "export default {}",
      "utf-8"
    );

    try {
      delete process.env.POURKIT_CONFIG_FILE;
      expect(resolveE2EConfigFile(root)).toBe("pourkit.config.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /*
  it("falls back to pourkit.config.example.ts when no real config exists", () => {
    delete process.env.POURKIT_CONFIG_FILE;
    expect(resolveE2EConfigFile(repoRoot())).toBe("pourkit.config.example.ts");
  });
  */
});

describe("parseArgs", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("defaults fullCheck to false when --full-check is not provided", () => {
    process.argv = ["node", "run-live-e2e.ts"];
    const result = parseArgs();
    expect(result.fullCheck).toBe(false);
  });

  it("sets fullCheck to true when --full-check is provided", () => {
    process.argv = ["node", "run-live-e2e.ts", "--full-check"];
    const result = parseArgs();
    expect(result.fullCheck).toBe(true);
  });

  it("preserves fast mode when other flags are present", () => {
    process.argv = ["node", "run-live-e2e.ts", "--keep", "--fail"];
    const result = parseArgs();
    expect(result.fullCheck).toBe(false);
    expect(result.keep).toBe(true);
    expect(result.fail).toBe(true);
  });

  it("parses --target argument", () => {
    process.argv = ["node", "run-live-e2e.ts", "--target", "prod"];
    const result = parseArgs();
    expect(result.targetName).toBe("prod");
    expect(result.fullCheck).toBe(false);
    expect(result.keep).toBe(false);
    expect(result.fail).toBe(false);
  });

  it("defaults cleanupOnly to false when --cleanup-only is not provided", () => {
    process.argv = ["node", "run-live-e2e.ts"];
    const result = parseArgs();
    expect(result.cleanupOnly).toBe(false);
  });

  it("sets cleanupOnly to true when --cleanup-only is provided", () => {
    process.argv = ["node", "run-live-e2e.ts", "--cleanup-only"];
    const result = parseArgs();
    expect(result.cleanupOnly).toBe(true);
  });

  it("parses --cleanup-only with other flags", () => {
    process.argv = ["node", "run-live-e2e.ts", "--cleanup-only", "--keep"];
    const result = parseArgs();
    expect(result.cleanupOnly).toBe(true);
    expect(result.keep).toBe(true);
    expect(result.fullCheck).toBe(false);
    expect(result.fail).toBe(false);
  });
});

describe("script-wrapper equivalence", () => {
  it("all pourkit:e2e scripts delegate to the same bash entrypoint", () => {
    const scripts = loadPackageScripts();
    const base = scripts["pourkit:e2e"];
    const full = scripts["pourkit:e2e:full"];
    const cleanup = scripts["pourkit:e2e:cleanup"];
    const testLive = scripts["pourkit:e2e:test-live"];

    expect(base).toBeDefined();
    expect(full).toBeDefined();
    expect(cleanup).toBeDefined();
    expect(testLive).toBeDefined();

    expect(base).toContain("npm run build --workspace pourkit");
    expect(base).toContain("node pourkit/dist/e2e/run-live-e2e.js");
    expect(base).not.toContain("run-e2e.sh");
    expect(full).toBe("npm run pourkit:e2e -- --full-check");
    expect(cleanup).toBe("npm run pourkit:e2e -- --cleanup-only");
    expect(testLive).toBe(
      "npm run build && npm run typecheck && npm run test && bash pourkit/e2e/test-live.sh"
    );
  });

  it("pourkit:e2e:full appends --full-check to the base pourkit:e2e command", () => {
    const scripts = loadPackageScripts();
    const base = scripts["pourkit:e2e"];
    const full = scripts["pourkit:e2e:full"];

    expect(full).toBe("npm run pourkit:e2e -- --full-check");
    expect(base).toBe(
      "npm run build --workspace pourkit && node pourkit/dist/e2e/run-live-e2e.js"
    );
  });

  it("--full-check flag resolves to full-check profile", () => {
    expect(resolveProfile(true)).toBe("full-check");
  });

  it("no flag resolves to fast profile", () => {
    expect(resolveProfile(false)).toBe("fast");
  });

  it("wrapper and direct flag reach the same mode-selection outcome", () => {
    const scripts = loadPackageScripts();
    const base = scripts["pourkit:e2e"];
    const full = scripts["pourkit:e2e:full"];

    expect(full).toBe("npm run pourkit:e2e -- --full-check");
    expect(base).toContain("node pourkit/dist/e2e/run-live-e2e.js");

    expect(resolveProfile(true)).toBe("full-check");
  });

  it("pourkit:e2e:cleanup appends --cleanup-only to the base pourkit:e2e command", () => {
    const scripts = loadPackageScripts();
    const base = scripts["pourkit:e2e"];
    const cleanup = scripts["pourkit:e2e:cleanup"];

    expect(cleanup).toBe("npm run pourkit:e2e -- --cleanup-only");
    expect(base).toContain("node pourkit/dist/e2e/run-live-e2e.js");
  });
});

describe("bundled entrypoint contract", () => {
  it("removes the legacy bash wrapper", () => {
    expect(
      existsSync(path.join(repoRoot(), "pourkit", "e2e", "run-e2e.sh"))
    ).toBe(false);
  });

  it("builds Pourkit before launching the bundled E2E runner", () => {
    const scripts = loadPackageScripts();
    expect(scripts["pourkit:e2e"]).toContain(
      "npm run build --workspace pourkit"
    );
    expect(scripts["pourkit:e2e"]).toContain(
      "node pourkit/dist/e2e/run-live-e2e.js"
    );
  });

  it("does not depend on temp-dist compile machinery", () => {
    const scripts = loadPackageScripts();
    expect(scripts["pourkit:e2e"]).not.toContain("e2e-dist");
    expect(scripts["pourkit:e2e"]).not.toContain("tsconfig.e2e.json");
    expect(scripts["pourkit:e2e"]).not.toContain("sed -i");
  });

  it("keeps the helper wrappers as thin delegations to the base E2E command", () => {
    const scripts = loadPackageScripts();
    expect(scripts["pourkit:e2e:full"]).toBe(
      "npm run pourkit:e2e -- --full-check"
    );
    expect(scripts["pourkit:e2e:cleanup"]).toBe(
      "npm run pourkit:e2e -- --cleanup-only"
    );
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));

describe("@pourkit/cli package", () => {
  const cliPkgPath = path.join(configDir, "package.json");
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf-8"));

  it("is public", () => {
    expect(cliPkg.private).toBe(false);
  });

  it("has expected version", () => {
    expect(cliPkg.version).toBe("0.1.0");
  });

  it("declares bin.pourkit pointing to dist/cli.js", () => {
    expect(cliPkg.bin?.pourkit).toBe("dist/cli.js");
  });

  it("requires node >=20", () => {
    expect(cliPkg.engines?.node).toBe(">=20");
  });

  it("restricts published files to dist", () => {
    expect(cliPkg.files).toEqual(["dist"]);
  });

  it("has dist/cli.js built and present", () => {
    const distPath = path.join(configDir, "dist/cli.js");
    expect(existsSync(distPath)).toBe(true);
  });

  it("excludes repository-private files from publish", () => {
    const distPath = path.join(configDir, "dist/cli.js");
    expect(existsSync(distPath)).toBe(true);
    const result = execSync("npm pack --dry-run --json", {
      cwd: configDir,
      encoding: "utf-8",
    });
    const packData = JSON.parse(result);
    const files: string[] = Array.isArray(packData)
      ? packData[0].files.map((f: { path: string }) => f.path)
      : packData.files.map((f: { path: string }) => f.path);

    expect(files).toContain("dist/cli.js");
    expect(files).not.toContain(".pourkit/CONTEXT.md");
    expect(files).not.toContain(".agents/");
    expect(files).not.toContain("node_modules/");
    expect(files).not.toContain(".changeset/");
  });
});

describe("@pourkit/logger package", () => {
  const loggerPkgPath = path.join(
    configDir,
    "..",
    "common",
    "logger",
    "package.json"
  );
  const loggerPkg = JSON.parse(readFileSync(loggerPkgPath, "utf-8"));

  it("remains private", () => {
    expect(loggerPkg.private).toBe(true);
  });
});

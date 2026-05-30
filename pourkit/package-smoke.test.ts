import { describe, expect, it } from "vitest";
import { builtinModules } from "node:module";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const runPackageSmoke = process.env.POURKIT_PACKAGE_SMOKE === "true";

const nodeBuiltinModules = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function packageNameForImport(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.includes("${")) return null;
  if (nodeBuiltinModules.has(specifier)) return null;

  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function readPackData(packOutput: string) {
  const packData = JSON.parse(packOutput);
  return Array.isArray(packData) ? packData[0] : packData;
}

describe("@pourkit/cli package", () => {
  const cliPkgPath = path.join(configDir, "package.json");
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf-8"));

  it("is public", () => {
    expect(cliPkg.private).toBe(false);
  });

  it("has expected version", () => {
    expect(cliPkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/);
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

  it("does not expose private @pourkit/* packages as runtime dependencies", () => {
    const deps = cliPkg.dependencies ?? {};
    const privatePourkitDeps = Object.keys(deps).filter((name) =>
      name.startsWith("@pourkit/")
    );

    expect(privatePourkitDeps).toEqual([]);
  });

  (runPackageSmoke ? it : it.skip)("has dist/cli.js built and present", () => {
    const distPath = path.join(configDir, "dist/cli.js");
    expect(existsSync(distPath)).toBe(true);
  });

  (runPackageSmoke ? it : it.skip)(
    "excludes repository-private files from publish",
    () => {
      const distPath = path.join(configDir, "dist/cli.js");
      expect(existsSync(distPath)).toBe(true);
      const result = execSync("npm pack --dry-run --json", {
        cwd: configDir,
        encoding: "utf-8",
      });
      const packData = readPackData(result);
      const files: string[] = packData.files.map(
        (f: { path: string }) => f.path
      );

      expect(files).toContain("dist/cli.js");
      expect(files.some((file) => file.startsWith(".pourkit/"))).toBe(false);
      expect(files.some((file) => file.startsWith(".agents/"))).toBe(false);
      expect(files.some((file) => file.startsWith("node_modules/"))).toBe(
        false
      );
      expect(files.some((file) => file.startsWith(".changeset/"))).toBe(false);
    }
  );

  (runPackageSmoke ? it : it.skip)(
    "declares runtime dependencies imported by the built CLI",
    () => {
      const distPath = path.join(configDir, "dist/cli.js");
      const source = readFileSync(distPath, "utf-8");
      const imports = [
        ...source.matchAll(/(?:import|from)\s+["']([^"']+)["']/g),
      ]
        .map((match) => packageNameForImport(match[1]))
        .filter((name): name is string => name !== null);
      const declaredDeps = new Set(Object.keys(cliPkg.dependencies ?? {}));
      const missingDeps = [...new Set(imports)].filter(
        (name) => !declaredDeps.has(name)
      );

      expect(missingDeps).toEqual([]);
    }
  );

  (runPackageSmoke ? it : it.skip)(
    "prints the package version from the built CLI",
    () => {
      const output = execSync("node dist/cli.js --version", {
        cwd: configDir,
        encoding: "utf-8",
      }).trim();

      expect(output).toBe(cliPkg.version);
    }
  );

  (runPackageSmoke ? it : it.skip)(
    "runs from a packed install without workspace dependencies",
    () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "pourkit-pack-smoke-"));
      const packDir = path.join(tempRoot, "pack");
      const installDir = path.join(tempRoot, "install");

      try {
        mkdirSync(packDir);
        const packOutput = execFileSync(
          "npm",
          ["pack", "--json", "--pack-destination", packDir],
          { cwd: configDir, encoding: "utf-8" }
        );
        const packData = readPackData(packOutput);
        const tarballPath = path.join(packDir, packData.filename);

        execFileSync("npm", ["install", "--prefix", installDir, tarballPath], {
          encoding: "utf-8",
          stdio: "pipe",
        });

        const output = execFileSync(
          path.join(installDir, "node_modules", ".bin", "pourkit"),
          ["--version"],
          { encoding: "utf-8" }
        ).trim();

        expect(output).toBe(cliPkg.version);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000
  );
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

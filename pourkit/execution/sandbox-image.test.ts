import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { describe, expect, it } from "vitest";
import { sandboxImageName } from "./sandbox-image";

const DOCKERFILE_PATH = new URL("../../.sandcastle/Dockerfile", import.meta.url)
  .pathname;

describe("sandboxImageName", () => {
  function repoWithDockerfile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-img-"));
    mkdirSync(join(dir, ".sandcastle"), { recursive: true });
    writeFileSync(join(dir, ".sandcastle", "Dockerfile"), content);
    return dir;
  }

  function emptyRepo(): string {
    return mkdtempSync(join(tmpdir(), "sandbox-img-"));
  }

  function imageNamePattern(repoDir: string): RegExp {
    const base = repoDir.replace(/.*[/\\]/, "").toLowerCase();
    return new RegExp(`^sandcastle:${base}-[0-9a-f]{8}$`);
  }

  it("produces a name with a sha256 fingerprint prefix", () => {
    const repo = repoWithDockerfile("FROM node:22");
    try {
      const name = sandboxImageName(repo);
      expect(name).toMatch(imageNamePattern(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("changes fingerprint when Dockerfile content changes", () => {
    const repo = repoWithDockerfile("content-a");
    try {
      const name1 = sandboxImageName(repo);
      writeFileSync(join(repo, ".sandcastle", "Dockerfile"), "content-b");
      const name2 = sandboxImageName(repo);
      expect(name1).not.toBe(name2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back when no Dockerfile exists", () => {
    const repo = emptyRepo();
    try {
      const name = sandboxImageName(repo);
      const base = repo.replace(/.*[/\\]/, "").toLowerCase();
      expect(name).toBe(`sandcastle:${base}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("produces a deterministic fingerprint for identical content", () => {
    const repo1 = repoWithDockerfile("same-content");
    const repo2 = repoWithDockerfile("same-content");
    try {
      const name1 = sandboxImageName(repo1);
      const name2 = sandboxImageName(repo2);
      expect(name1).not.toBe(name2);
      expect(name1.split("-").pop()).toBe(name2.split("-").pop());
    } finally {
      rmSync(repo1, { recursive: true, force: true });
      rmSync(repo2, { recursive: true, force: true });
    }
  });

  describe("Dockerfile regression contract", () => {
    it("uses the expected Node base image", () => {
      const content = readFileSync(DOCKERFILE_PATH, "utf-8");
      expect(content).toContain("FROM node:22-trixie");
    });

    it("installs opencode-ai", () => {
      const content = readFileSync(DOCKERFILE_PATH, "utf-8");
      expect(content).toContain("npm install -g opencode-ai@latest");
    });

    it("does not install @ast-grep/cli", () => {
      const content = readFileSync(DOCKERFILE_PATH, "utf-8");
      expect(content).not.toContain("@ast-grep/cli");
    });

    it("sets USER agent", () => {
      const content = readFileSync(DOCKERFILE_PATH, "utf-8");
      expect(content).toContain("USER agent");
    });

    it("sets WORKDIR /home/agent", () => {
      const content = readFileSync(DOCKERFILE_PATH, "utf-8");
      expect(content).toContain("WORKDIR /home/agent");
    });

    it("sets PATH with /home/agent/.local/bin", () => {
      const content = readFileSync(DOCKERFILE_PATH, "utf-8");
      expect(content).toContain('ENV PATH="/home/agent/.local/bin:${PATH}"');
    });

    it("runs rtk init -g --opencode", () => {
      const content = readFileSync(DOCKERFILE_PATH, "utf-8");
      expect(content).toContain("rtk init -g --opencode");
    });
  });
});

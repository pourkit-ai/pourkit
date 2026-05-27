import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

interface GitHubCliViolation {
  path: string;
  line: number;
  match: string;
}

const PROHIBITED_PATTERNS: RegExp[] = [
  /execCapture\(["']gh["'],/,
  /GitHub CLI/,
  /\bgh\s+(issue|pr|api|auth|repo|run|secret|variable|workflow|config|extension|search|gist)\b/,
];

function repoRoot(): string {
  return path.resolve(__dirname, "..");
}

const EXCLUDED_PATHS: string[] = [
  "CHANGELOG.md",
  ".pourkit/docs/adr/0010-use-octokit-instead-of-github-cli-for-github-api-operations.md",
];

function shouldScanPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (EXCLUDED_PATHS.includes(normalized)) return false;
  return true;
}

function findGitHubCliViolations(
  filePath: string,
  content: string
): GitHubCliViolation[] {
  if (!shouldScanPath(filePath)) return [];

  const violations: GitHubCliViolation[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PROHIBITED_PATTERNS) {
      const match = line.match(pattern);
      if (match !== null) {
        violations.push({ path: filePath, line: i + 1, match: match[0] });
        break;
      }
    }
  }

  return violations;
}

const SCOPED_PREFIXES = [
  "pourkit/",
  ".agents/skills/",
  ".pourkit/docs/",
  "README.md",
];

function isScopedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return SCOPED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isScanCandidate(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!isScopedPath(normalized)) return false;
  if (normalized === "pourkit/github-cli-usage.test.ts") return false;
  const ext = path.extname(normalized);
  if (ext !== ".ts" && ext !== ".md" && ext !== ".mjs" && ext !== ".cjs")
    return false;
  return true;
}

function collectCandidates(root: string): string[] {
  const candidates: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const relativePath = path.relative(root, fullPath);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (
            entry === "node_modules" ||
            entry === ".git" ||
            entry === ".tmp" ||
            entry === ".sandcastle" ||
            entry === "dist"
          )
            continue;
          queue.push(fullPath);
        } else if (isScanCandidate(relativePath)) {
          candidates.push(fullPath);
        }
      } catch {
        continue;
      }
    }
  }
  return candidates;
}

describe("shouldScanPath", () => {
  it("excludes CHANGELOG.md", () => {
    expect(shouldScanPath("CHANGELOG.md")).toBe(false);
  });

  it("excludes Octokit migration ADR", () => {
    expect(
      shouldScanPath(
        ".pourkit/docs/adr/0010-use-octokit-instead-of-github-cli-for-github-api-operations.md"
      )
    ).toBe(false);
  });

  it("includes other paths by default", () => {
    expect(shouldScanPath("pourkit/sample.ts")).toBe(true);
    expect(shouldScanPath(".agents/skills/some-skill/SKILL.md")).toBe(true);
    expect(shouldScanPath("README.md")).toBe(true);
  });

  it("does not broadly exclude all ADRs", () => {
    expect(
      shouldScanPath(
        ".pourkit/docs/adr/0006-boundary-only-zod-validation-for-config.md"
      )
    ).toBe(true);
  });
});

describe("findGitHubCliViolations", () => {
  it("does not flag local git command usage", () => {
    expect(
      findGitHubCliViolations("sample.ts", 'execCapture("git", ["status"])')
    ).toEqual([]);
  });

  it("reports execCapture gh violations", () => {
    const result = findGitHubCliViolations(
      "pourkit/sample.ts",
      'execCapture("gh", ["issue", "list"])'
    );
    expect(result).toContainEqual(
      expect.objectContaining({ path: "pourkit/sample.ts", line: 1 })
    );
  });

  it("reports GitHub CLI text violations", () => {
    const result = findGitHubCliViolations(
      "docs/guide.md",
      "Install the GitHub CLI before running this command."
    );
    expect(result).toContainEqual(
      expect.objectContaining({ path: "docs/guide.md", line: 1 })
    );
  });

  it("reports gh command example violations", () => {
    const result = findGitHubCliViolations(
      "docs/guide.md",
      "Run `gh issue list` to view open issues."
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        path: "docs/guide.md",
        line: 1,
        match: "gh issue",
      })
    );
  });

  it("does not flag ordinary words containing gh", () => {
    expect(
      findGitHubCliViolations("sample.ts", "const tough = though;")
    ).toEqual([]);
  });

  it("does not flag GH_TOKEN environment variable", () => {
    expect(findGitHubCliViolations("sample.ts", "GH_TOKEN")).toEqual([]);
  });

  it("returns empty for excluded paths", () => {
    expect(
      findGitHubCliViolations(
        "CHANGELOG.md",
        'execCapture("gh", ["issue", "list"])'
      )
    ).toEqual([]);
  });

  it("reports gh pr subcommand pattern", () => {
    const result = findGitHubCliViolations(
      "skill.md",
      "never use raw gh pr create"
    );
    expect(result).toContainEqual(expect.objectContaining({ match: "gh pr" }));
  });

  it("reports violations on correct lines", () => {
    const content = [
      "const a = 1;",
      'execCapture("gh", ["issue", "list"])',
      "const b = 2;",
    ].join("\n");
    const result = findGitHubCliViolations("test.ts", content);
    expect(result).toContainEqual(
      expect.objectContaining({ path: "test.ts", line: 2 })
    );
  });
});

describe("static scan", () => {
  const root = repoRoot();
  const candidates = collectCandidates(root);

  if (candidates.length === 0) {
    it("placeholder", () => {});
    return;
  }

  const allViolations: GitHubCliViolation[] = [];
  for (const filePath of candidates) {
    const relativePath = path.relative(root, filePath);
    if (!shouldScanPath(relativePath)) continue;
    try {
      const content = readFileSync(filePath, "utf-8");
      const violations = findGitHubCliViolations(relativePath, content);
      allViolations.push(...violations);
    } catch {
      continue;
    }
  }

  it("finds no GitHub CLI violations in scanned files", () => {
    if (allViolations.length > 0) {
      const message = allViolations
        .map((v) => `${v.path}:${v.line} - matches "${v.match}"`)
        .join("\n");
      expect(
        allViolations,
        `Found ${allViolations.length} GitHub CLI violation(s):\n${message}`
      ).toEqual([]);
    }
  });
});

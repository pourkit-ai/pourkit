const BODY_PARENT_SECTION_REGEX = /## Parent\s*\n([\s\S]*?)(?=\n## |$)/i;
const AFFECTED_CODE_PATHS_SECTION_REGEX =
  /## Affected code paths\s*\n([\s\S]*?)(?=\n## |$)/i;
const PRD_REF_REGEX = /\b(PRD-\d+)\b/i;
const CHILD_TITLE_REGEX = /^\s*(PRD-\d+)\s*\/\s*I-\d+\b/i;

export type ParsedStackedIssue = {
  parentRef?: string;
  parentSource?: "body" | "title";
  bodyParentRef?: string;
  titleParentRef?: string;
  affectedCodePaths: string[];
  isChildIssue: boolean;
  siblingGroupingKey?: string;
  warnings: string[];
};

export function parseStackedIssue(
  title: string,
  body: string | null
): ParsedStackedIssue {
  const bodyParentRef = parseParentRefFromBody(body);
  const titleParentRef = parseParentRefFromTitle(title);
  const warnings: string[] = [];

  if (bodyParentRef && titleParentRef && bodyParentRef !== titleParentRef) {
    warnings.push(
      `Parent mismatch: body references ${bodyParentRef} but title references ${titleParentRef}`
    );
  }

  const parentRef = bodyParentRef ?? titleParentRef;
  const parentSource = bodyParentRef
    ? "body"
    : titleParentRef
      ? "title"
      : undefined;

  return {
    parentRef,
    parentSource,
    bodyParentRef,
    titleParentRef,
    affectedCodePaths: parseAffectedCodePaths(body),
    isChildIssue: Boolean(bodyParentRef ?? titleParentRef),
    siblingGroupingKey: parentRef,
    warnings,
  };
}

export function parseParentRefFromBody(
  body: string | null
): string | undefined {
  if (!body) return undefined;

  const section = body.match(BODY_PARENT_SECTION_REGEX)?.[1];
  if (!section) return undefined;

  return normalizeParentRef(section.match(PRD_REF_REGEX)?.[1]);
}

export function parseParentRefFromTitle(title: string): string | undefined {
  return normalizeParentRef(title.match(CHILD_TITLE_REGEX)?.[1]);
}

export function parseAffectedCodePaths(body: string | null): string[] {
  if (!body) return [];

  const section = body.match(AFFECTED_CODE_PATHS_SECTION_REGEX)?.[1];
  if (!section) return [];

  const paths = new Set<string>();

  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();

    if (!line.startsWith("-")) continue;

    if (/^-\s+(Class\/Module|Functions\/Methods|New):/i.test(line)) {
      continue;
    }

    const inlineCodePath = line.match(/`([^`]+)`/)?.[1]?.trim();
    if (inlineCodePath) {
      paths.add(inlineCodePath);
      continue;
    }

    const plainPath = line.replace(/^-\s+/, "").trim();
    if (looksLikeRepoPath(plainPath)) {
      paths.add(plainPath);
    }
  }

  return Array.from(paths);
}

function normalizeParentRef(ref: string | undefined): string | undefined {
  return ref?.trim().toUpperCase();
}

function looksLikeRepoPath(value: string): boolean {
  return /[./][A-Za-z0-9_-]/.test(value) && !value.includes(":");
}

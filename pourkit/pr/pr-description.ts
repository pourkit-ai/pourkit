export interface PrDescription {
  title: string;
  body: string;
}

const CONVENTIONAL_TITLE_PATTERN =
  /^(feat|fix|perf|refactor|docs|test|chore|ci|build)(\([^)]+\))?!?:\s+\S/;

export class PrDescriptionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrDescriptionProtocolError";
  }
}

const SECTION_HEADING_PATTERN = /^## (PR Title|PR Body)\s*$/gm;

interface SectionMatch {
  heading: "PR Title" | "PR Body";
  startIndex: number;
  endIndex: number;
}

function extractSections(output: string): SectionMatch[] {
  const sections: SectionMatch[] = [];
  let match: RegExpExecArray | null;

  const re = new RegExp(SECTION_HEADING_PATTERN);
  while ((match = re.exec(output)) !== null) {
    const heading = match[1] as "PR Title" | "PR Body";
    sections.push({
      heading,
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return sections;
}

function contentAfter(
  output: string,
  sections: SectionMatch[],
  section: SectionMatch
): string {
  const index = sections.indexOf(section);
  const nextSection = sections[index + 1];
  const start = section.endIndex;
  const end = nextSection?.startIndex ?? output.length;
  return output.slice(start, end).trim();
}

export function parsePrDescription(output: string): PrDescription {
  const sections = extractSections(output);

  const titleSections = sections.filter((s) => s.heading === "PR Title");
  const bodySections = sections.filter((s) => s.heading === "PR Body");

  if (titleSections.length === 0) {
    throw new PrDescriptionProtocolError(
      'Missing required section "## PR Title"'
    );
  }
  if (titleSections.length > 1) {
    throw new PrDescriptionProtocolError(
      `Duplicate "## PR Title" sections found (${titleSections.length})`
    );
  }
  if (bodySections.length === 0) {
    throw new PrDescriptionProtocolError(
      'Missing required section "## PR Body"'
    );
  }
  if (bodySections.length > 1) {
    throw new PrDescriptionProtocolError(
      `Duplicate "## PR Body" sections found (${bodySections.length})`
    );
  }

  const title = contentAfter(output, sections, titleSections[0]);
  const body = contentAfter(output, sections, bodySections[0]);

  if (title.length === 0) {
    throw new PrDescriptionProtocolError('"## PR Title" section is empty');
  }
  if (body.length === 0) {
    throw new PrDescriptionProtocolError('"## PR Body" section is empty');
  }

  return { title, body };
}

export function ensureConventionalPrTitle(
  title: string,
  commitSummaries: string
): string {
  const trimmedTitle = title.trim();
  const normalizedTitle =
    trimmedTitle.match(/^`([^`]+)`$/)?.[1] ?? trimmedTitle;
  if (CONVENTIONAL_TITLE_PATTERN.test(normalizedTitle)) {
    return normalizedTitle;
  }

  const inferredType = inferConventionalType(commitSummaries) ?? "chore";
  return `${inferredType}: ${normalizedTitle}`;
}

function inferConventionalType(commitSummaries: string): string | null {
  for (const line of commitSummaries.split("\n")) {
    const subject = line.trim().replace(/^[0-9a-f]+\s+/, "");
    const match = subject.match(CONVENTIONAL_TITLE_PATTERN);
    if (match) {
      return match[1];
    }
  }

  return null;
}

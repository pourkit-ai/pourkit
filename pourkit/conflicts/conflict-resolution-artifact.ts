export type ConflictResolutionArtifactStatus = "resolved" | "ambiguous";

export interface ConflictResolutionVerificationRow {
  command: string;
  result: string;
  notes: string;
}

export interface ConflictResolutionArtifact {
  status: ConflictResolutionArtifactStatus;
  summary: string;
  files: string[];
  verification?: ConflictResolutionVerificationRow[];
  raw: string;
}

export class ConflictResolutionArtifactProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictResolutionArtifactProtocolError";
  }
}

const VALID_STATUSES: ConflictResolutionArtifactStatus[] = [
  "resolved",
  "ambiguous",
];

const SECTION_HEADING_PATTERN = /^## (Status|Summary|Files|Verification)\s*$/gm;

interface SectionMatch {
  heading: "Status" | "Summary" | "Files" | "Verification";
  startIndex: number;
  endIndex: number;
}

function extractSections(output: string): SectionMatch[] {
  const sections: SectionMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(SECTION_HEADING_PATTERN);
  while ((match = re.exec(output)) !== null) {
    const heading = match[1] as "Status" | "Summary" | "Files" | "Verification";
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

function extractMarker(output: string): string | null {
  const matches = output.matchAll(
    /<conflict-resolution>\s*(resolved|ambiguous)\s*<\/conflict-resolution>/g
  );
  const results = Array.from(matches);
  if (results.length > 1) {
    throw new ConflictResolutionArtifactProtocolError(
      "Duplicate <conflict-resolution>...</conflict-resolution> markers"
    );
  }
  return results.length === 1 ? results[0][1] : null;
}

function parseFileList(filesContent: string): string[] {
  return filesContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const rest = line.slice(2).trim();
      const codeMatch = rest.match(/^`([^`]+)`/);
      return codeMatch ? codeMatch[1] : rest;
    });
}

function parseVerificationTable(
  content: string
): ConflictResolutionVerificationRow[] {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tableLines = lines.filter((l) => l.startsWith("|") && l.endsWith("|"));

  // index 0 = heading row, index 1 = separator row, index 2+ = data rows
  const dataRows = tableLines.slice(2);

  return dataRows.map((row) => {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    return {
      command: cells[0] ?? "",
      result: cells[1] ?? "",
      notes: cells[2] ?? "",
    };
  });
}

export function parseConflictResolutionArtifact(
  output: string
): ConflictResolutionArtifact {
  if (!output.trim()) {
    throw new ConflictResolutionArtifactProtocolError(
      "Empty conflict resolution artifact output"
    );
  }

  const sections = extractSections(output);

  const statusSections = sections.filter((s) => s.heading === "Status");
  const summarySections = sections.filter((s) => s.heading === "Summary");
  const filesSections = sections.filter((s) => s.heading === "Files");

  if (statusSections.length > 1) {
    throw new ConflictResolutionArtifactProtocolError(
      'Duplicate "## Status" sections'
    );
  }
  if (summarySections.length > 1) {
    throw new ConflictResolutionArtifactProtocolError(
      'Duplicate "## Summary" sections'
    );
  }
  if (filesSections.length > 1) {
    throw new ConflictResolutionArtifactProtocolError(
      'Duplicate "## Files" sections'
    );
  }

  const verificationSections = sections.filter(
    (s) => s.heading === "Verification"
  );

  const statusSection = statusSections[0];
  const summarySection = summarySections[0];
  const filesSection = filesSections[0];

  if (!statusSection) {
    throw new ConflictResolutionArtifactProtocolError(
      'Missing required section "## Status"'
    );
  }
  if (!summarySection) {
    throw new ConflictResolutionArtifactProtocolError(
      'Missing required section "## Summary"'
    );
  }
  if (!filesSection) {
    throw new ConflictResolutionArtifactProtocolError(
      'Missing required section "## Files"'
    );
  }

  const statusRaw = contentAfter(output, sections, statusSection);
  const summary = contentAfter(output, sections, summarySection);
  const filesContent = contentAfter(output, sections, filesSection);

  if (!statusRaw) {
    throw new ConflictResolutionArtifactProtocolError(
      '"## Status" section is empty'
    );
  }
  if (!summary) {
    throw new ConflictResolutionArtifactProtocolError(
      '"## Summary" section is empty'
    );
  }

  if (!VALID_STATUSES.includes(statusRaw as ConflictResolutionArtifactStatus)) {
    throw new ConflictResolutionArtifactProtocolError(
      `Unsupported status "${statusRaw}". Allowed statuses: ${VALID_STATUSES.join(", ")}`
    );
  }

  const markerStatus = extractMarker(output);
  if (!markerStatus) {
    throw new ConflictResolutionArtifactProtocolError(
      "Missing <conflict-resolution>...</conflict-resolution> marker"
    );
  }

  if (markerStatus !== statusRaw) {
    throw new ConflictResolutionArtifactProtocolError(
      `Conflict resolution status "${statusRaw}" does not match marker "${markerStatus}"`
    );
  }

  let verification: ConflictResolutionVerificationRow[] | undefined;
  if (verificationSections.length > 0) {
    const verificationContent = contentAfter(
      output,
      sections,
      verificationSections[0]
    );
    verification = parseVerificationTable(verificationContent);
  }

  return {
    status: statusRaw as ConflictResolutionArtifactStatus,
    summary,
    files: parseFileList(filesContent),
    verification,
    raw: output,
  };
}

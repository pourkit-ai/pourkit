import { readFile } from "node:fs/promises";

export const DEFAULT_MANUAL_PR_BODY = `## Summary

- Summarize why this branch exists.

## Changes

- Summarize the final net change in this branch.`;

export interface PrBodyOptions {
  body?: string;
  bodyFile?: string;
  issue?: number;
}

export interface PrBodyInput {
  defaultBody: string;
  options: PrBodyOptions;
}

export async function buildPrBody(input: PrBodyInput): Promise<string> {
  const { defaultBody, options } = input;

  let bodyText = await resolveBodyText(defaultBody, options);

  bodyText = appendClosingRef(bodyText, options.issue);

  return bodyText;
}

export function ensureClosingRefs(body: string, issue?: number): string {
  const stripped = stripClosingRefs(body || "");
  if (issue === undefined) {
    return stripped;
  }
  if (!stripped) {
    return `Closes #${issue}`;
  }
  return `${stripped}\n\nCloses #${issue}`;
}

function stripClosingRefs(body: string): string {
  // Strip whole lines that consist of an optional bullet prefix plus a closing-keyword issue ref
  const linePattern =
    /^[ \t]*[-*+]\s+(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*#\d+\s*$/gim;
  let result = body.replace(linePattern, "");

  // Strip remaining inline closing refs
  const inlinePattern =
    /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*#\d+/gi;
  result = result.replace(inlinePattern, "").trimEnd();

  return result;
}

async function resolveBodyText(
  defaultBody: string,
  options: PrBodyOptions
): Promise<string> {
  if (options.body && options.bodyFile) {
    throw new Error("--body and --body-file cannot be used together");
  }

  if (options.body !== undefined) {
    return options.body;
  }

  if (options.bodyFile !== undefined) {
    return await readFile(options.bodyFile, "utf-8");
  }

  return defaultBody;
}

function appendClosingRef(body: string, issue?: number): string {
  if (issue === undefined) {
    return body;
  }

  const existingRefs = extractClosingRefs(body);

  if (existingRefs.has(issue)) {
    return body;
  }

  return `${body}\n\nCloses #${issue}`;
}

function extractClosingRefs(body: string): Set<number> {
  const refs = new Set<number>();
  const pattern =
    /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*#(\d+)/gi;
  let match;

  while ((match = pattern.exec(body)) !== null) {
    refs.add(parseInt(match[1], 10));
  }

  return refs;
}

import type { IssueData } from "../shared/config";
import { slugify } from "../shared/common";

export function renderBranchName(template: string, issue: IssueData): string {
  return renderTemplate(template, issue);
}

function renderTemplate(template: string, issue: IssueData): string {
  const issueSlug = slugify(issue.title);

  return template
    .replace(/\{\{issue\.number\}\}/g, String(issue.number))
    .replace(/\{\{issue\.title\}\}/g, issue.title)
    .replace(/\{\{issue\.body\}\}/g, issue.body)
    .replace(/\{\{issue\.slug\}\}/g, issueSlug)
    .replace(/\{\{issue\.state\}\}/g, issue.state);
}

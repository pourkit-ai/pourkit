# Commit Style

Agents must write commit messages that are readable in GitHub, release notes, PR summaries, and terminal history.

## Required Format

Use a conventional-commit subject, a blank line, then a bullet list body when the commit needs explanation.

```text
<type>: <short imperative summary>

- Explain the first meaningful change and why it matters.
- Explain the second meaningful change and its boundary.
- Mention tests, migrations, or compatibility impact when relevant.

Closes #123
```

## Subject Rules

- Use `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, or `build`.
- Keep the subject under 72 characters when practical.
- Use imperative mood: `add`, `fix`, `split`, `move`, `document`.
- Do not end the subject with a period.
- Do not cram multiple details into the subject.

## Body Rules

- Prefer bullets for any non-trivial commit body.
- Keep each bullet focused on one idea.
- Explain why the change exists, not just which files changed.
- Use backticks for code identifiers, paths, commands, and flags.
- Keep issue-closing refs in a final footer, not mixed into the summary bullets.
- Issue-backed Pourkit-managed work uses exactly one current-Issue closing footer.
- Only the current Issue may be closed; parent PRDs, sibling Issues, and unrelated Issues must never appear in closing footers.
- Issue-less work may omit a closing footer.
- Leave the body empty for obvious one-line commits.

## Bad

```text
refactor: introduce review-refactor loop behind thin orchestration

Move review logic, refactor logic, artifact passing, and iteration
counting into a new ReviewLoop class behind Reviewer and Refactor
interfaces. Reduce issue.ts to startup and top-level orchestration.

Closes #34
```

## Good

```text
refactor: introduce review-refactor loop behind thin orchestration

- Move review logic, refactor logic, artifact passing, and iteration counting into `ReviewLoop`.
- Put the module behind `Reviewer` and `Refactor` seams so startup code stays thin.
- Reduce `issue.ts` to workflow startup and top-level orchestration.
- Fold `review-runner.ts` responsibilities into the loop module.

Closes #34
```

## Agent Checklist

Before committing, agents must verify:

- The subject accurately classifies the work.
- The body uses bullets when it has more than one idea.
- The bullets render cleanly in GitHub markdown.
- The closing issue reference is in the footer.
- Only the current Issue is referenced in the closing footer (no parent PRDs, sibling Issues, or unrelated Issues).
- The commit body is not one wrapped paragraph.

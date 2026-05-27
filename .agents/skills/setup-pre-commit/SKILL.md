---
name: setup-pre-commit
description: Set up Husky pre-commit hooks with lint-staged (Prettier), type checking, tests, build, and full-repo prettier:check in the current repo. Use when user wants to add pre-commit hooks, set up Husky, configure lint-staged, or add commit-time formatting/typechecking/testing/building.
---

# Setup Pre-Commit Hooks

## What This Sets Up

- **Husky** pre-commit hook
- **lint-staged** running Prettier on all staged files
- **Prettier** config (if missing)
- **prettier:check** and **prettier:write** npm scripts for full-repo formatting
- **typecheck**, **test**, and **build** scripts in the pre-commit hook

## Steps

### 1. Detect package manager

Check for `package-lock.json` (npm), `pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `bun.lockb` (bun). Use whichever is present. Default to npm if unclear.

### 2. Install dependencies

Install as devDependencies:

```
husky lint-staged prettier
```

### 3. Initialize Husky

```bash
npx husky init
```

This creates `.husky/` dir and adds `prepare: "husky"` to package.json.

### 4. Create `.husky/pre-commit`

Write this file (no shebang needed for Husky v9+):

```
npx lint-staged
npm run prettier:check
npm run typecheck
npm run test:agent
npm run build
```

**Adapt**: Replace `npm` with detected package manager. If repo has no `prettier:check`, `typecheck`, `test`, or `build` script in package.json, omit those lines and tell the user.

### 5. Create `.lintstagedrc`

Use explicit globs so prettier doesn't touch markdown files:

```json
{
  "*.{js,ts,cjs,mjs,jsx,tsx,json,html,css,scss,yml,yaml}": "prettier --ignore-unknown --write"
}
```

### 6. Add `prettier:check` and `prettier:write` scripts

Add to `package.json` scripts:

```json
"prettier:check": "prettier --ignore-unknown --check .",
"prettier:write": "prettier --ignore-unknown --write .",
```

### 7. Create `.prettierignore`

Exclude markdown files from prettier formatting:

```
*.md
```

### 8. Create `.prettierrc` (if missing)

Only create if no Prettier config exists. Use these defaults:

```json
{
  "useTabs": false,
  "tabWidth": 2,
  "printWidth": 80,
  "singleQuote": false,
  "trailingComma": "es5",
  "semi": true,
  "arrowParens": "always"
}
```

### 9. Verify

- [ ] `.husky/pre-commit` exists and is executable
- [ ] `.lintstagedrc` exists
- [ ] `prepare` script in package.json is `"husky"`
- [ ] `prettier` config exists
- [ ] `prettier:check` and `prettier:write` scripts in package.json
- [ ] Run `npm run prettier:check` to verify full-repo formatting
- [ ] Run `npx lint-staged` to verify it works
- [ ] Run `npm run typecheck`, `npm run test:agent`, `npm run build` pass

### 10. Commit

Stage all changed/created files and commit with message: `Add pre-commit hooks (husky + lint-staged + prettier)`

This will run through the new pre-commit hooks — a good smoke test that everything works.

## Notes

- Husky v9+ doesn't need shebangs in hook files
- `prettier --ignore-unknown` skips files Prettier can't parse (images, etc.)
- The pre-commit runs lint-staged first (fast, staged-only), then prettier:check (full-repo formatting check), then typecheck, test, and build

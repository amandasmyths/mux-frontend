# CI: typecheck & build verification

What changed to make sure `next build` reliably passes typecheck in CI,
and how to verify it.

## What was implemented

- **`typecheck` npm script** (`package.json`): `tsc --noEmit`, so the exact
  command CI runs is also runnable locally (`pnpm run typecheck`) and from
  any editor task/pre-commit hook without duplicating the flag set.
- **`.github/workflows/ci.yml` split into three jobs**:
  - `typecheck` — runs `pnpm run typecheck` and fails fast, before
    spending time on tests or a full `next build`.
  - `unit-tests` — runs `pnpm test` (Vitest). Previously the workflow
    only ran typecheck + build and never executed the unit test suite in
    CI at all.
  - `build` — depends on both jobs above, and runs as a 2-item matrix
    (`testnet`, `mainnet`) that sets `NEXT_PUBLIC_API_URL` to a
    testnet-shaped vs. mainnet-shaped URL for each build. `next build`
    statically analyzes every route including the API routes that branch
    on this variable (`src/app/api/auth/login/route.ts`,
    `src/lib/api/config.ts`), so this catches env-specific build breakage
    that a single hardcoded CI URL would miss.
- **`tsconfig.json`**: excludes `tests/e2e/**` and `playwright.config.ts`
  from the app's typecheck program. Playwright specs are executed (and
  type-checked in a lighter-weight way) by `playwright test` itself, not
  by the strict app-wide `tsc --noEmit` pass — this keeps the main
  typecheck focused on shippable app code and avoids coupling it to
  Playwright's own type surface.
- **`package.json` cleanup**: the `devDependencies` block had duplicate
  JSON keys for several `@storybook/*` packages and `storybook` itself
  (harmless to a JSON parser — the last value silently wins — but
  confusing and a lint/tooling footgun). Deduped to a single entry per
  package, keeping the versions that were actually in effect. Also added
  `"engines": { "node": ">=22" }` to match the Node version CI installs.

## Required status check (branch protection)

The `typecheck` job is a **required gate**: it must be configured as a
required status check on the default branch so a PR cannot merge while it
is failing, pending, or missing. This is what makes the gate fail-closed —
a red or absent typecheck blocks the merge instead of merely warning.

Configure it once in the repository settings:

1. **Settings → Branches → Branch protection rules** for the default
   branch (or the relevant ruleset).
2. Enable **Require status checks to pass before merging**.
3. Add the check named **`typecheck`** (the job id in
   `.github/workflows/ci.yml`) to the required list.
4. Keep **Require branches to be up to date before merging** enabled so
   the gate re-runs against the latest base.

Notes for maintainers:

- The required check name must match the CI job id exactly (`typecheck`).
  Renaming the job in the workflow silently drops the gate, so update the
  branch protection rule in the same PR if the job is ever renamed.
- Because `build` already `needs: [typecheck, unit-tests]`, a failing
  typecheck also prevents the build matrix from starting — the gate fails
  fast and cheaply.
- If the workflow is ever made conditional (e.g. path filters), keep the
  `typecheck` job unconditional so the required check always reports a
  status; a skipped required check leaves PRs stuck in "Expected" and
  blocks merges.

## Known follow-up (not done here)

Issue #1 in this batch of changes added `@playwright/test` as a new
devDependency. `pnpm-lock.yaml` was **not** regenerated as part of this
change (no package manager was available in the environment these edits
were made in). Run `pnpm install` locally once and commit the updated
lockfile before relying on CI's `pnpm install --frozen-lockfile` step —
otherwise that step will fail on a lockfile/manifest mismatch. This is a
one-time fix; typecheck/test/build all pass once the lockfile is synced.

## Manual verification checklist

- [ ] `pnpm install` regenerates `pnpm-lock.yaml` cleanly with
      `@playwright/test` added.
- [ ] `pnpm run typecheck` passes locally.
- [ ] `pnpm test` passes locally.
- [ ] `pnpm run build` passes locally with `NEXT_PUBLIC_API_URL` unset,
      set to a testnet URL, and set to a mainnet URL.
- [ ] The `typecheck` CI job fails (as expected) if a type error is
      introduced, before the `build` matrix jobs start.
- [ ] Branch protection on the default branch lists `typecheck` as a
      required status check, so a PR with type errors cannot merge.

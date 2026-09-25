# Real-backend Playwright E2E

End-to-end tests that run the Mux frontend against a **real backend**
(real Soroban RPC / Horizon / wallet stack) instead of the mocked
fixtures used by the default `tests/e2e/` suite.

These specs are the last line of defence for the money path: login,
wallet creation, and payment flows. They must fail closed — if the
required environment is not present, the run aborts instead of silently
falling back to mocks.

## Layout

| Path | Purpose |
| --- | --- |
| `playwright.real-backend.config.ts` | Playwright config for the real-backend project. |
| `tests/e2e-real-backend.config.test.ts` | CI guard that asserts the config invariants below. |
| `tests/e2e/real-backend/helpers.ts` | Shared env parsing, auth, and navigation helpers. |
| `tests/e2e/real-backend/login.spec.ts` | Login / session critical path. |
| `tests/e2e/real-backend/wallets.spec.ts` | Wallet creation and balance critical path. |

## Required environment variables

The config is **fail-closed**: every variable below is required and the
run aborts with a clear error if any is missing or malformed. No secret
values are ever committed to the repo — they are injected by CI or the
operator's shell.

| Variable | Required | Description |
| --- | --- | --- |
| `E2E_REAL_BACKEND_BASE_URL` | yes | Absolute `http(s)` URL of the deployed frontend under test. |
| `E2E_REAL_BACKEND_API_URL` | yes | Absolute `http(s)` URL of the backend API the frontend talks to. |
| `E2E_REAL_BACKEND_NETWORK` | yes | `testnet` or `mainnet`. Anything else aborts. |
| `E2E_REAL_BACKEND_USER` | yes | Test account identifier (email or handle). |
| `E2E_REAL_BACKEND_PASSWORD` | yes | Test account password. Never logged. |
| `E2E_REAL_BACKEND_TIMEOUT_MS` | no | Per-test timeout override (default `60000`). |

`E2E_REAL_BACKEND_NETWORK=mainnet` additionally requires
`E2E_REAL_BACKEND_ALLOW_MAINNET=1`; without it the run aborts. This is
the kill-switch for accidental mainnet execution.

## Invariants

1. **Fail closed.** Missing or malformed env vars abort the run before
   any browser is launched. There is no mock fallback.
2. **No secrets in artifacts.** Passwords, JWTs, and API keys are never
   written to traces, screenshots, or logs. Helpers redact them.
3. **Stable selectors.** Specs use `data-testid` selectors only; no
   text or CSS-structure coupling.
4. **Idempotent setup.** Helpers tolerate re-runs and replayed requests
   without creating duplicate wallets or sessions.
5. **Network guard.** `mainnet` requires the explicit allow flag above.

## Running locally

```bash
export E2E_REAL_BACKEND_BASE_URL="https://app.example.test"
export E2E_REAL_BACKEND_API_URL="https://api.example.test"
export E2E_REAL_BACKEND_NETWORK="testnet"
export E2E_REAL_BACKEND_USER="wave-contributor@example.test"
export E2E_REAL_BACKEND_PASSWORD="<from your secret store>"

npx playwright test --config=playwright.real-backend.config.ts
```

To run a single spec:

```bash
npx playwright test --config=playwright.real-backend.config.ts \
  tests/e2e/real-backend/login.spec.ts
```

## Runbook (Stellar Wave contributors)

1. Confirm you have access to the testnet deployment and the test
   account credentials (ask in the Wave channel; never paste secrets in
   issues or PRs).
2. Export the variables above in your shell. Do **not** commit a
   `.env` file.
3. Run the config guard first:
   `npx vitest run tests/e2e-real-backend.config.test.ts`.
   It must pass before you run the browser suite.
4. Run the real-backend suite. If it aborts with a missing-env error,
   fix your environment — do not weaken the config.
5. On failure, attach the Playwright HTML report (secrets are redacted)
   to the PR and link the failing spec.
6. For mainnet-affecting changes, land behind a feature flag and
   document the rollback in the PR description.

## CI

The real-backend suite is gated: it only runs when the required secrets
are configured for the workflow. The config guard
(`tests/e2e-real-backend.config.test.ts`) always runs and is a required
check, so a broken config fails CI even when the live suite is skipped.

## Related docs

- `docs/e2e-real-backend-testing.md` — full setup and design notes.
- `docs/security-ux-guards.md` — authz and UX guardrails.
- `README.md` — project overview.

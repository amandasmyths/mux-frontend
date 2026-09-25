# Real-Backend E2E Testing

This document describes how the Mux frontend exercises the **login critical path**
against a real backend (Soroban RPC + auth service) rather than mocks. It is the
reference for issue #765 ("Login e2e + real-backend login") and complements
[`security-ux-guards.md`](./security-ux-guards.md) and the top-level
[`README.md`](../README.md).

## Goals

- Prove the login flow works end-to-end against a real backend, not a stub.
- Fail closed: any authz, RPC, or config error must block the session, never
  silently degrade to an unauthenticated state.
- Keep the suite deterministic and safe to run in CI (testnet only by default).

## Scope

In scope:

- Wallet connect -> challenge -> signature -> session issuance.
- Account-abstraction (AA) session bootstrap for invisible wallets.
- Authz enforcement on login surfaces (owner / delegate / guardian /
  API-key / JWT).
- Stable error codes and correlation ids surfaced to the client.

Out of scope:

- Payment / spend paths (covered by their own suites).
- Mainnet runs (see [Mainnet safety](#mainnet-safety)).

## Layout

```
tests/e2e/                 # shared harness + fixtures
tests/e2e/real-backend/    # specs that require a live backend
```

Specs in `tests/e2e/real-backend/` are gated behind the `REAL_BACKEND=1`
environment flag so the default `tests/e2e/` run stays hermetic.

## Running

```bash
# Hermetic suite (mocks) — always safe
pnpm test:e2e

# Real-backend suite — requires a reachable testnet backend
REAL_BACKEND=1 \
  MUX_RPC_URL="https://soroban-testnet.stellar.org" \
  MUX_AUTH_URL="https://auth.testnet.mux.example" \
  pnpm test:e2e:real-backend
```

Required environment variables for the real-backend suite:

## Runbook: provisioning a real-backend environment

For Stellar Wave contributors wiring this suite into a new environment
(testnet/staging), follow these steps in order. Each step is fail-closed:
if a step can't be completed, stop — do not run the suite against a
partially-configured backend.

1. **Confirm the backend target.** Verify `NEXT_PUBLIC_API_URL` points at
   a real `mux-backend` you are authorized to test against. Never point
   this at mainnet or a production money-path deployment without an
   explicit readiness checklist sign-off (see `docs/security-ux-guards.md`).
2. **Provision a low-privilege QA account.** Create a dedicated account
   on that backend with the minimum role needed to exercise login and
   wallet reads. Do not reuse a personal, admin, or custody-bearing
   account. Record its email as `E2E_TEST_EMAIL`.
3. **Store the password as a CI secret.** Put the account password in the
   CI secret store as `E2E_TEST_PASSWORD`. Never commit it, never echo it
   in logs, and never place it in a `NEXT_PUBLIC_*` variable.
4. **Wire the CI job.** Export all three vars into the job that runs
   `pnpm exec playwright test --config=playwright.real-backend.config.ts`.
   If the secrets are not provisioned for an environment, leave them
   unset — the suite skips with `REAL_BACKEND_SKIP_REASON` rather than
   failing or silently passing.
5. **Verify fail-closed behavior.** Run the config test
   (`tests/e2e-real-backend.config.test.ts`) and confirm the negative
   path still holds: with the required env absent, the config must not
   produce a green run that never touched a real backend.
6. **Rollback.** This suite is read-only against the backend (login +
   wallet reads) and gated behind env presence, so rollback is simply
   unsetting the three vars — the suite becomes a no-op. No backend
   state is mutated by these specs; if a future spec adds a write path,
   it must land behind a feature flag with its own rollback note.

## Security

- Test credentials are a real (if low-privilege) account on a real
  backend — treat `E2E_TEST_PASSWORD` like any other secret: CI secret
  store only, never committed, never logged.
- Same rule as the rest of the app (`docs/frontend-env-vars.md`,
  `docs/auth-local-setup.md`): no custody secret — `MUX_API_KEY`,
  `MUX_API_SECRET`, or a session token — is ever read from a
  `NEXT_PUBLIC_*` variable or written to `localStorage`. The
  real-backend specs don't introduce any new storage path; they exercise
  the existing HttpOnly `mux_auth_token` cookie flow end-to-end.
- The suite is deny-by-default: it only runs when explicitly provisioned
  with real-backend env, and it never asserts mock-only credentials or
  tokens. See `docs/security-ux-guards.md` for the broader guard model.

## Required environment variables

| Variable        | Purpose                                   |
| --------------- | ----------------------------------------- |
| `REAL_BACKEND`  | Must be `1` to enable the suite.          |
| `MUX_RPC_URL`   | Soroban RPC endpoint (testnet by default).|
| `MUX_AUTH_URL`  | Auth service base URL.                    |
| `MUX_NETWORK`   | `testnet` (default) or `mainnet`.         |

If any required variable is missing the suite **skips with a clear message**
rather than falling back to mocks — a real-backend spec must never pass by
accident against a stub.

## Login critical path

The real-backend login spec asserts the following invariants:

1. **Challenge is server-issued.** The client never fabricates a nonce; it
   requests one from `MUX_AUTH_URL` and echoes it back verbatim.
2. **Signature is verified server-side.** A tampered or replayed signature is
   rejected with a stable error code (see below).
3. **Session is fail-closed.** If the auth service or RPC is unreachable, the
   client surfaces an error and does **not** create a session.
4. **Authz is enforced.** A caller without the required role (owner / delegate /
   guardian / API-key / JWT) is denied by default; new privileged surfaces are
   deny-by-default.
5. **Correlation ids propagate.** Every request carries a correlation id that is
   echoed in responses and included in logs for traceability.

## Stable error codes

The login surface returns typed errors with stable codes so clients and tests
can branch deterministically:

| Code                     | Meaning                                        |
| ------------------------ | ---------------------------------------------- |
| `AUTH_CHALLENGE_EXPIRED` | Challenge nonce expired or already consumed.   |
| `AUTH_SIGNATURE_INVALID` | Signature failed verification.                 |
| `AUTH_ROLE_DENIED`       | Caller lacks the required role.                |
| `AUTH_SESSION_REVOKED`   | Session or delegate was revoked.               |
| `AUTH_BACKEND_UNAVAIL`   | Auth service / RPC unreachable (fail-closed).  |
| `AUTH_CONFIG_INVALID`    | Testnet/mainnet misconfiguration detected.     |

Each error response includes a `correlationId` field. Tests assert on the code
and that a correlation id is present, never on free-form messages.

## Edge cases covered

- **Replay / concurrency.** A consumed challenge cannot be reused; concurrent
  logins with the same nonce yield exactly one success.
- **Dependency outage.** RPC or auth outage returns `AUTH_BACKEND_UNAVAIL` and
  no session is created.
- **Auth expiry / wrong role / revoked delegate.** Returns `AUTH_ROLE_DENIED`
  or `AUTH_SESSION_REVOKED` respectively.
- **Adversarial input.** Oversized or malformed payloads are rejected before
  reaching the backend.
- **Testnet vs mainnet misconfig.** Mismatched `MUX_NETWORK` and endpoint
  returns `AUTH_CONFIG_INVALID`.

## Observability

- Logs include the correlation id and error code, never raw signatures, JWTs,
  API keys, or webhook secrets.
- Metrics are emitted for login attempts, failures by code, and backend
  latency. No key material is ever attached to a metric label.

## Mainnet safety

The real-backend suite defaults to **testnet**. Running against mainnet
requires `MUX_NETWORK=mainnet` **and** an explicit opt-in flag; without both,
`AUTH_CONFIG_INVALID` is returned and the run aborts. Any money-path or
mainnet-affecting change must land behind a feature flag with a documented
rollback in the PR description.

## CI

- The hermetic `tests/e2e/` suite runs on every PR and is a required check.
- The real-backend suite runs on a schedule / manual trigger against testnet
  and is not required for merge (it depends on external services).

## References

- [`README.md`](../README.md)
- [`docs/security-ux-guards.md`](./security-ux-guards.md)
- `tests/e2e/`
- `tests/e2e/real-backend/`

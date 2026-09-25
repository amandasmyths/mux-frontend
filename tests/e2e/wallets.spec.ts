import { test, expect } from '@playwright/test';

/**
 * Route loading UX e2e coverage (issue #773).
 *
 * Verifies that wallet/route entrypoints surface a deterministic loading state,
 * a stable error code + correlation id on failure, and fail-closed behavior when
 * the backend dependency is unavailable. See docs/security-ux-guards.md and
 * ROUTE_LOADING_README.md for the documented contract.
 */

const ROUTE_LOADING_TIMEOUT_MS = 15_000;

// Stable error codes the route-loading surface must emit (deny-by-default).
type RouteLoadingErrorCode =
  | 'ROUTE_LOADING_UNAVAILABLE'
  | 'ROUTE_LOADING_UNAUTHORIZED'
  | 'ROUTE_LOADING_TIMEOUT';

const STABLE_ERROR_CODES: RouteLoadingErrorCode[] = [
  'ROUTE_LOADING_UNAVAILABLE',
  'ROUTE_LOADING_UNAUTHORIZED',
  'ROUTE_LOADING_TIMEOUT',
];

const CORRELATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('Route loading UX', () => {
  test('shows a loading state before the route resolves', async ({ page }) => {
    await page.goto('/wallets');

    // The loading indicator must be visible while the route is resolving.
    const loading = page.getByTestId('route-loading');
    await expect(loading).toBeVisible({ timeout: ROUTE_LOADING_TIMEOUT_MS });

    // Once resolved, the loading state must be cleared (no stuck spinner).
    await expect(loading).toBeHidden({ timeout: ROUTE_LOADING_TIMEOUT_MS });
  });

  test('renders the wallet surface after the route resolves', async ({ page }) => {
    await page.goto('/wallets');

    await expect(page.getByTestId('route-loading')).toBeHidden({
      timeout: ROUTE_LOADING_TIMEOUT_MS,
    });
    await expect(page.getByTestId('wallet-list')).toBeVisible({
      timeout: ROUTE_LOADING_TIMEOUT_MS,
    });
  });

  test('fails closed with a stable error code and correlation id', async ({ page }) => {
    // Simulate a backend/RPC outage on the route-loading dependency.
    await page.route('**/api/**', (route) => route.abort('failed'));

    await page.goto('/wallets');

    const error = page.getByTestId('route-loading-error');
    await expect(error).toBeVisible({ timeout: ROUTE_LOADING_TIMEOUT_MS });

    // The error must carry a stable, documented error code.
    const code = await error.getAttribute('data-error-code');
    expect(STABLE_ERROR_CODES).toContain(code as RouteLoadingErrorCode);

    // The error must carry a correlation id for observability.
    const correlationId = await error.getAttribute('data-correlation-id');
    expect(correlationId).toBeTruthy();
    expect(correlationId).toMatch(CORRELATION_ID_PATTERN);

    // Fail-closed: no wallet surface is rendered on dependency outage.
    await expect(page.getByTestId('wallet-list')).toBeHidden();
  });

  test('does not leak secrets in the route-loading error surface', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort('failed'));

    await page.goto('/wallets');

    const error = page.getByTestId('route-loading-error');
    await expect(error).toBeVisible({ timeout: ROUTE_LOADING_TIMEOUT_MS });

    const text = (await error.textContent()) ?? '';
    // Redaction guard: no raw key material, JWTs, or webhook secrets in the UI.
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(text).not.toMatch(/S[A-Z2-7]{55}/);
    expect(text).not.toMatch(/whsec_[A-Za-z0-9]+/);
  });
});

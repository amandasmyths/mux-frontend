import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/**
 * Guards for issue #770: the CI typecheck gate must be a required, fail-closed
 * check so PRs cannot merge with TypeScript errors.
 */
describe('CI typecheck required gate', () => {
  it('exposes a typecheck script wired to the TypeScript compiler', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>;
    };

    const typecheck = pkg.scripts?.typecheck;
    expect(typecheck, 'package.json must define a "typecheck" script').toBeTruthy();
    expect(typecheck).toMatch(/tsc\b/);
    expect(typecheck).toMatch(/--noEmit/);
  });

  it('runs the typecheck script in the CI workflow', () => {
    const workflow = readRepoFile('.github/workflows/ci.yml');

    expect(workflow).toMatch(/typecheck/i);
  });

  it('marks the typecheck job as a required gate (no continue-on-error)', () => {
    const workflow = readRepoFile('.github/workflows/ci.yml');

    // A required gate must fail the workflow on type errors, so the typecheck
    // step/job must not be allowed to continue on error.
    const typecheckBlocks = workflow
      .split(/\n(?=\s{2,}\w)/)
      .filter((block) => /typecheck/i.test(block));

    expect(typecheckBlocks.length).toBeGreaterThan(0);
    for (const block of typecheckBlocks) {
      expect(block).not.toMatch(/continue-on-error:\s*true/i);
    }
  });
});

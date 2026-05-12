import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the package version from package.json at runtime.
 *
 * This file deliberately lives at the same nesting depth as `src/index.ts`
 * so the relative path to `package.json` resolves the same way whether the
 * module is loaded from `src/` (via tsx) or from `dist/` (after build):
 *
 *   src/version.ts   → ../package.json  ✓
 *   dist/version.js  → ../package.json  ✓
 *
 * Reading at runtime means version cannot drift from package.json the way a
 * hardcoded constant would.
 */
function loadVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to fallback.
  }
  return '0.0.0';
}

export const PACKAGE_VERSION: string = loadVersion();

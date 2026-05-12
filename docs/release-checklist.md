# Release Checklist

Run these steps before tagging and publishing a new version of `pubchem-mcp`.

## Pre-flight

- [ ] Working tree is clean (`git status` shows no uncommitted changes).
- [ ] Update `version` in `package.json` per semver (`major.minor.patch`).
  - `src/version.ts` reads from `package.json` at runtime, so no separate constant to update.
- [ ] Update `CHANGELOG.md` (or release notes) with user-facing changes.

## Build & static checks

```bash
rm -rf node_modules dist
npm ci
npm run build
npm run typecheck
npm run lint
```

All four must succeed with zero errors.

## Tests

```bash
npm test
```

Expected: all unit and mocked-MCP-integration tests pass; live tests are skipped because `PUBCHEM_MCP_LIVE_TESTS` is unset.

Optional live verification (requires outbound DNS+HTTPS to `pubchem.ncbi.nlm.nih.gov`):

```bash
PUBCHEM_MCP_LIVE_TESTS=1 npm test
```

If live tests fail with `MCP tool error` payloads, the diagnostic message includes the full error response — typically a 503, a DNS failure, or a rate-limit hit. Re-run after the apparent cause resolves; do not silence the gate.

## Audit

```bash
npm audit --omit=dev   # must be clean
npm audit              # should be clean for a publishable release
```

If `npm audit` reports a dev-only vulnerability we cannot upgrade past in this release, document the source, severity, dev-only status, impact, mitigation, and follow-up in `docs/release-risk-register.md` and decide explicitly whether to proceed.

## Pack dry-run

```bash
npm pack --dry-run
```

Confirm the tarball contents include:

- `dist/**` (build output)
- `bin/pubchem-mcp` (executable shim)
- `README.md`, `LICENSE`
- `docs/**`
- `examples/**`

And do **not** include:

- `node_modules/`
- `test/`
- `*.test.ts` files
- `.env`, `.env.local`

The `files` field in `package.json` controls this — review when changing source layout.

## Package metadata

- [ ] Confirm `npm view pubchem-mcp` (a) returns the previous version if this is a re-publish, or (b) returns 404 (not yet published) for the first release. If the name is taken by someone else, stop and pick a new name.
- [ ] Confirm `package.json` `name`, `version`, `bin`, `files`, `engines`, `license` are correct.
- [ ] Confirm `package.json` `repository`, `homepage`, `bugs` URLs point to the public repo (set these before first publish).

## Smoke test the built binary

```bash
cat <<'EOF' | PUBCHEM_LOG_LEVEL=silent node dist/index.js
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
EOF
```

Expected: a JSON-RPC `initialize` result, then a `tools/list` result containing all 10 tools.

## Publish

```bash
npm publish --access public
```

(Drop `--access public` for scoped packages with a paid private plan if applicable. Unscoped packages publish public by default.)

After publish:

- [ ] `git tag vX.Y.Z` and push the tag.
- [ ] Create a GitHub Release with the changelog excerpt.
- [ ] Smoke-test from a clean directory: `npx pubchem-mcp@<version>` and verify it starts.

## Rollback

If a critical bug is discovered post-publish:

- Patch the bug, bump the version, and republish.
- Do **not** `npm unpublish` once a version has been live for more than 72h (npm policy and ecosystem impact).
- Consider `npm deprecate pubchem-mcp@<bad-version> '...'` to warn installs of the broken version.

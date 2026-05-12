# Publishing pubchem-mcp

This document is the gate between the repository and the public npm registry. **Do not run `npm publish` until every item in this file is resolved.**

## 1. Replace placeholder metadata in `package.json`

These fields contain literal `TODO` markers and must be set before publishing:

- `author` — full name and optional email of the maintainer (e.g. `"Jane Doe <jane@example.com>"`).
- `repository.url` — final public Git URL. Replace `TODO-OWNER` with the GitHub org/user.
- `homepage` — typically `https://github.com/<owner>/pubchem-mcp#readme`.
- `bugs.url` — typically `https://github.com/<owner>/pubchem-mcp/issues`.

The `publishConfig.access = "public"` is already set so an unscoped package publishes publicly; do not change without intent.

Optional but recommended:

- Add a `funding` field if you accept sponsorship.
- Add the maintainer's GitHub handle in `contributors` if multiple people maintain the package.

## 2. Confirm the npm name is available

```bash
npm view pubchem-mcp --registry=https://registry.npmjs.org/
```

Expected outcomes:

- **404 / "not found"** — the name is free; you can claim it on first publish.
- **Returns existing metadata for an unrelated package** — someone else owns the name. Either pick a new name (update `package.json#name` and the `bin` entry), or contact the current owner about a transfer. Do **not** publish under a name you do not own.
- **Returns metadata for a previous version of this package** — you are republishing. Verify the existing maintainer list is correct (`npm owner ls pubchem-mcp`) and that you have publish permission.

## 3. Bump the version

```bash
# pick one — never publish without bumping
npm version patch   # bugfixes / docs
npm version minor   # backward-compatible features
npm version major   # breaking changes
```

`src/version.ts` reads from `package.json` at runtime, so the version reported by `get_server_status` and the `User-Agent` cannot drift from the published version.

Update `CHANGELOG.md` with the new version's entry before tagging.

## 4. Run the full release checklist

See [`docs/release-checklist.md`](docs/release-checklist.md). All eight gates (build, typecheck, lint, test, audit, audit-prod, pack dry-run, smoke test) must pass.

In a network-capable environment, also run:

```bash
PUBCHEM_MCP_LIVE_TESTS=1 npm test
```

and verify the live suite completes within a reasonable time (≤ 60 s). If your environment has DNS blocked to `pubchem.ncbi.nlm.nih.gov`, the live suite should still complete promptly (≤ 60 s) because every retry path now surfaces a typed `PubChemTransientError` instead of hanging.

## 5. Publish

```bash
npm publish
```

After publish:

- Tag the commit: `git tag vX.Y.Z && git push --tags`.
- Create a GitHub Release.
- Smoke-test from a clean directory:
  ```bash
  cd "$(mktemp -d)"
  npm init -y
  npm install pubchem-mcp@latest
  cat <<'EOF' | PUBCHEM_LOG_LEVEL=silent npx pubchem-mcp
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
  {"jsonrpc":"2.0","method":"notifications/initialized"}
  {"jsonrpc":"2.0","id":2,"method":"tools/list"}
  EOF
  ```
  Expect an `initialize` response followed by a `tools/list` listing all 10 tools.

## 6. Rollback

If a critical bug is found post-publish:

- Patch and republish; **do not** `npm unpublish` after 72 hours.
- Consider `npm deprecate pubchem-mcp@<bad-version> "<reason>"` to warn users on broken versions.

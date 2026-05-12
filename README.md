# pubchem-mcp

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) server for [PubChem](https://pubchem.ncbi.nlm.nih.gov/) chemical data. Built in TypeScript, designed to be embedded in MCP clients like Claude Desktop, Claude Code, Cursor, and Cline.

It uses PubChem's documented APIs — **PUG-REST** as primary backend and **PUG-View** for curated annotations — and respects PubChem's published rate-limit and dynamic throttling policy.

## What this server does

- Resolves compound identifiers (name, CID, SMILES, InChI, InChIKey, formula) to PubChem CIDs.
- Retrieves normalized compound summaries and computed properties.
- Returns synonyms, structures (SMILES / InChI / InChIKey / SDF / full JSON).
- Runs identity, similarity, substructure, and superstructure searches.
- Fetches bioassay summaries and the assays associated with a compound.
- Pulls curated annotation sections from PUG-View with source citations.
- Exposes server diagnostics including the most recent PubChem throttle state.

## What this server does **not** do

- It does **not** scrape PubChem HTML pages.
- It does **not** predict ADMET, toxicity, regulatory status, environmental fate, or pharmacophore features.
- It does **not** provide medical, legal, regulatory, or laboratory-safety advice.
- It does **not** write to PubChem; this server is read-only.

Annotation text returned from PUG-View is **source data** drawn from PubChem's references. It is not the server's analysis or recommendation.

## Install

Requires Node.js ≥ 18.17.

```bash
# Run without installing
npx pubchem-mcp

# or install globally
npm install -g pubchem-mcp
pubchem-mcp
```

## MCP client configuration

### Claude Desktop

Add this to your `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "pubchem": {
      "command": "npx",
      "args": ["-y", "pubchem-mcp"]
    }
  }
}
```

See [`examples/mcp-configs/claude-desktop.json`](examples/mcp-configs/claude-desktop.json).

### Claude Code

Add this to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "pubchem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "pubchem-mcp"]
    }
  }
}
```

See [`examples/mcp-configs/claude-code.mcp.json`](examples/mcp-configs/claude-code.mcp.json).

## Local development

```bash
git clone <repo-url>
cd pubchem-mcp
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm start          # runs dist/index.js (stdio)
```

Live integration tests (which call the real PubChem API) are skipped by default. They require outbound DNS+HTTPS access to `pubchem.ncbi.nlm.nih.gov`; sandboxed environments without network access should leave the flag unset. Run them with:

```bash
PUBCHEM_MCP_LIVE_TESTS=1 npm test
```

If a live test fails, the assertion message includes the full structured tool-error payload (`error`, `category`, `retryable`, `endpoint`) — diagnose from that rather than re-running blindly.

## Tools

| Name | Purpose | Backend |
|---|---|---|
| `resolve_compound` | Resolve a free-form identifier (name / CID / SMILES / InChI / InChIKey / formula) to CIDs. | PUG-REST |
| `get_compound` | Fetch a normalized compound summary by CID. | PUG-REST |
| `get_compound_properties` | Batch computed properties for up to 100 CIDs from an allowlisted set. | PUG-REST |
| `get_compound_synonyms` | Synonyms for a CID (up to 500). | PUG-REST |
| `get_compound_structure` | Get a compound structure as SMILES, InChI, InChIKey, SDF, or full JSON. | PUG-REST |
| `search_structure` | Identity / similarity / substructure / superstructure search by SMILES or InChI. | PUG-REST |
| `get_assay` | Normalized assay summary by AID. | PUG-REST |
| `get_compound_assays` | List AIDs of bioassays associated with a CID. | PUG-REST |
| `get_compound_annotations` | Curated annotation sections (pharmacology, hazards, literature, etc.) with source citations. | PUG-View |
| `get_server_status` | Diagnostics: version, configured limits, cache stats, throttle state, uptime. | — |

Full tool reference with example inputs and outputs lives in [`docs/tools.md`](docs/tools.md).

## Resources

| URI template | Returns |
|---|---|
| `pubchem://compound/{cid}` | Normalized compound summary |
| `pubchem://compound/{cid}/properties` | Default computed property set |
| `pubchem://compound/{cid}/synonyms` | Up to 50 synonyms |
| `pubchem://compound/{cid}/structure` | Full PUG-REST JSON structure record |
| `pubchem://compound/{cid}/annotations` | PUG-View annotation sections |
| `pubchem://assay/{aid}` | Normalized bioassay summary |

See [`docs/resources.md`](docs/resources.md).

## Prompts

- `compound-research-brief` — sourced research brief for one compound.
- `compare-compounds` — markdown comparison table across multiple compounds.
- `safety-annotation-review` — review of PubChem-sourced safety annotations with strict no-extrapolation rules.

## Environment variables

All optional. See [`.env.example`](.env.example) for the full list.

| Var | Default | Purpose |
|---|---|---|
| `PUBCHEM_RPS` | 4 | Per-second cap (hard max 5; PubChem documents 5 req/sec) |
| `PUBCHEM_RPM` | 240 | Per-minute cap (hard max 400) |
| `PUBCHEM_TIMEOUT_MS` | 30000 | Per-request timeout |
| `PUBCHEM_MAX_RETRIES` | 4 | Retry attempts for transient failures |
| `PUBCHEM_CACHE_TTL_MS` | 86400000 | 24h cache TTL |
| `PUBCHEM_CACHE_DISABLE` | unset | Set to `1` to disable cache |
| `PUBCHEM_CACHE_MAX_ENTRIES` | 1000 | Cache LRU bound |
| `PUBCHEM_BASE_URL` | PubChem PUG-REST | Override for testing/proxying |
| `PUBCHEM_VIEW_BASE_URL` | PubChem PUG-View | Override for testing/proxying |
| `PUBCHEM_CONTACT_URL` | unset | Appended to `User-Agent` (recommended for production) |
| `PUBCHEM_LOG_LEVEL` | `info` | pino level (trace/debug/info/warn/error/fatal/silent) |
| `PUBCHEM_MCP_LIVE_TESTS` | unset | Set to `1` to run live PubChem tests |

## PubChem rate-limit policy

The server defends both directions of the rate limit:

- **Outbound throttling**: a token bucket caps requests at 4 req/sec (configurable, hard max 5) and a sliding 60-second window caps at 240 req/min (configurable, hard max 400). Requests queue rather than burst.
- **Dynamic throttling**: every response's `X-Throttling-Control` header is parsed. Yellow / Red / Black states cause the next request to wait 200 ms / 1 s / 5 s respectively. The most recent state is reported by `get_server_status`.
- **Retries**: 429 / 500 / 502 / 503 / 504 and network errors are retried with exponential backoff (500 ms → 16 s) plus jitter, capped at `PUBCHEM_MAX_RETRIES` attempts. 400 / 404 / 405 / 501 are **not** retried.
- **Caching**: identical GET requests are cached in memory for 24h by default. Disable with `PUBCHEM_CACHE_DISABLE=1`.
- **User-Agent**: `pubchem-mcp/<version>` plus the optional `PUBCHEM_CONTACT_URL`.

Full discussion in [`docs/pubchem-access.md`](docs/pubchem-access.md).

## Safety and limitations

This server retrieves data from PubChem. It does not provide medical, toxicological, regulatory, legal, or laboratory-safety advice. Users must verify critical chemistry and safety decisions with authoritative primary sources and qualified professionals.

See [`docs/safety-and-limitations.md`](docs/safety-and-limitations.md).

## Troubleshooting

- **`503 Service Unavailable`** — PubChem is throttling. The client retries automatically with exponential backoff; if it persists, reduce `PUBCHEM_RPS` (default 4, hard cap 5) and `PUBCHEM_RPM`. Watch `get_server_status` for the parsed `X-Throttling-Control` color.
- **`Persistent yellow/red throttle status`** — your traffic is steadily near PubChem's window. Lower `PUBCHEM_RPS` to 2–3 and add a longer delay between bursts. Set `PUBCHEM_CONTACT_URL` to a project URL so PubChem operators can identify your traffic.
- **`List key polling timed out`** — a large async structure search exceeded the 60s polling budget. Reduce the result set or use a `fast*` (synchronous) search.
- **`Unsupported property name(s)`** — `get_compound_properties` rejects values outside the allowlist; the error returns `category: "validation"`, `retryable: false`, and lists every supported name.
- **InChI lookup returns `400 Bad Request`** — InChI lookups are sent as `POST /compound/inchi/cids/JSON` with a form-urlencoded body. If you see a 400, the InChI string itself is malformed; path-encoded InChI is no longer used. Validate the InChI with an external InChI parser before resubmitting.
- **MCP server appears to "hang" on startup** — stdio servers wait silently for an `initialize` frame; this is normal behavior for stdio MCP servers. Pair it with a client.
- **No data returned for a compound annotation heading** — PubChem may not have that section for that compound. The server will not fabricate one.
- **Live test failures with `Cannot read properties of undefined`** — this used to happen when network was unavailable; live tests now include the full MCP error payload in the assertion message. If you see DNS/network errors, leave `PUBCHEM_MCP_LIVE_TESTS` unset on hosts without outbound HTTPS to `pubchem.ncbi.nlm.nih.gov`.

## License

[MIT](LICENSE)

# PubChem access policy

This document describes how `pubchem-mcp` interacts with PubChem's published APIs. The behaviors here are not optional — they enforce PubChem's documented limits and protect the service from accidental abuse.

## Backends

- **PUG-REST** (`https://pubchem.ncbi.nlm.nih.gov/rest/pug`) — structured compound / assay data, property tables, synonyms, structure search. Primary backend.
- **PUG-View** (`https://pubchem.ncbi.nlm.nih.gov/rest/pug_view`) — curated annotation sections with source citations. Used only for `get_compound_annotations` and `pubchem://compound/{cid}/annotations`.

The server never scrapes `pubchem.ncbi.nlm.nih.gov` HTML pages and never calls undocumented endpoints.

## Rate limit policy

PubChem publishes hard caps of **5 requests/second** and **400 requests/minute** per client. The server defaults to a conservative **4 req/sec, 240 req/minute** and exposes hard caps in `src/infrastructure/config.ts` to prevent misconfiguration above PubChem's documented ceiling.

The limiter has two tiers:

- **Per-second spacing** — minimum spacing of `1000/rps` ms between requests. A request that arrives too soon waits.
- **Per-minute sliding window** — drops timestamps older than 60s, then waits until the oldest timestamp falls outside the window when at capacity.

Requests are queued serially via a promise chain so the server never bursts. Multiple parallel tool calls share the same queue.

## Dynamic throttling

Every response includes `X-Throttling-Control`, e.g.:

```
Request Count status: Green (10%), Request Time status: Green (5%), Service status: Green (20%)
```

The parser tolerates malformed/abbreviated headers. It computes a `worstStatus` across all reported categories and maps that to a pre-request delay applied to the **next** call:

| Status | Pre-request delay |
|---|---|
| Green / unknown | 0 ms |
| Yellow | 200 ms |
| Red | 1000 ms |
| Black | 5000 ms |

The current state is available via `get_server_status`.

## Retry policy

Retried (with exponential backoff 500 ms → 16 s, ±20% jitter, capped at `PUBCHEM_MAX_RETRIES` total attempts):

- HTTP `429 Too Many Requests`
- HTTP `500`, `502`, `503`, `504`
- Network errors and AbortError on timeout

Not retried (typed as `PubChemValidationError` / `PubChemNotFoundError` / `PubChemUnsupportedOperationError`):

- HTTP `400`
- HTTP `404`
- HTTP `405` / `501`
- All other 4xx (treated as validation)

PubChem also returns a `Fault` object inside 2xx bodies for some failure modes; the client maps those to the same typed errors based on `Fault.Code`.

## Timeouts

`PUBCHEM_TIMEOUT_MS` (default 30s) is enforced via `AbortController`. Caller-supplied `AbortSignal`s are honored and merged.

## Caching

In-memory TTL cache, default 24h, LRU-bounded to `PUBCHEM_CACHE_MAX_ENTRIES`. Only successful responses are cached. Disable with `PUBCHEM_CACHE_DISABLE=1`. Cache stats are surfaced by `get_server_status`.

## POST / form-urlencoded input

PubChem documents `POST` with an `application/x-www-form-urlencoded` body as the supported channel for **InChI** input (and for SDF and very large structure queries that would exceed URL length limits). The client exposes this as `postFormJson(url, form)`. It runs through the same pipeline as GET — rate limit, throttle backoff, AbortController timeout, `User-Agent`, `X-Throttling-Control` parsing, exponential-backoff retry, typed error mapping, sanitized endpoint labels — with one difference: **POST responses are never cached**, because the request body is part of the response identity and we do not currently hash it into the cache key.

Currently used for:

- `resolveCompound({ identifierType: 'inchi' })` → `POST /compound/inchi/cids/JSON`
- `searchStructure({ queryType: 'inchi' })` → `POST /compound/{fastidentity|fastsimilarity_2d|fastsubstructure|fastsuperstructure}/inchi/cids/JSON`

SMILES lookups continue to use path-encoded GET.

## ListKey async polling

For async structure searches that return `202 Accepted` with `Waiting.ListKey`, the client polls `/compound/listkey/{key}/cids/JSON` every 2s for up to 30 attempts (≈60s). On expiry it throws `PubChemTransientError`.

## User-Agent

Every request carries:

```
User-Agent: pubchem-mcp/<version>[ (+<PUBCHEM_CONTACT_URL>)]
```

The optional contact URL is appended only when `PUBCHEM_CONTACT_URL` is set. Production deployments should set it to a project URL or maintainer contact so PubChem operators can reach you if usage patterns become problematic.

## Bulk data

For large-scale extraction, use PubChem's [FTP downloads](https://pubchem.ncbi.nlm.nih.gov/docs/downloads) rather than this server. PUG-REST is not intended for bulk dumps.

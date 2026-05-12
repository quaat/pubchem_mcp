# Tools

All tools return JSON inside an MCP text content block. Successful responses include a `_meta` object with `source`, `backend`, `retrievedAt`, the original `query`, and an optional `warnings[]` array. Errors return `{ error, category, retryable, endpoint }` and set `isError: true`.

---

## `resolve_compound`

Resolve a free-form compound identifier to one or more PubChem CIDs.

**Input**

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string | required | Name, CID, SMILES, InChI, InChIKey, or formula |
| `identifierType` | enum `name`/`cid`/`smiles`/`inchi`/`inchikey`/`formula`/`auto` | `auto` | `auto` infers conservatively |
| `limit` | integer (1-100) | 10 | Maximum candidates |
| `includeProperties` | boolean | `true` | Enrich each candidate with a compact property set |

**Output (sketch)**

```json
{
  "query": "aspirin",
  "identifierType": "name",
  "candidates": [
    {
      "cid": 2244,
      "title": "Aspirin",
      "molecularFormula": "C9H8O4",
      "molecularWeight": 180.16,
      "canonicalSmiles": "CC(=O)OC1=CC=CC=C1C(=O)O",
      "inchiKey": "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
      "pubchemUrl": "https://pubchem.ncbi.nlm.nih.gov/compound/2244"
    }
  ],
  "_meta": { "source": "PubChem", "backend": "PUG-REST", "retrievedAt": "..." }
}
```

Backend: PUG-REST `/compound/{type}/{query}/cids/JSON` then `/compound/cid/{cids}/property/...`.

**InChI input**: when `identifierType` is `inchi`, the server submits the InChI as a `POST /compound/inchi/cids/JSON` with a form-urlencoded body (`inchi=<value>`) — PubChem's documented channel for InChI lookups. Path-encoded InChI is not used.

Limitations: name lookups can be ambiguous; the server returns at most `limit` candidates without further re-ranking.

---

## `get_compound`

Fetch a normalized compound summary by CID.

**Input**

| Field | Type | Default |
|---|---|---|
| `cid` | positive integer | required |
| `includeRaw` | boolean | `false` (raw included only if under 64 KB) |

Output: a `NormalizedCompound` plus `_meta`. See `src/pubchem/pubchemTypes.ts` for the full shape.

Backend: PUG-REST property table.

---

## `get_compound_properties`

Retrieve selected computed PubChem properties for up to 100 CIDs.

**Input**

| Field | Type | Default | Notes |
|---|---|---|---|
| `cids` | array of positive integers | required | 1-100 |
| `properties` | array of strings | default set | Validated against `src/pubchem/propertyRegistry.ts` |
| `includePubChemUrls` | boolean | `true` | Set false to omit web links |

The default property set is documented in [`propertyRegistry.ts`](../src/pubchem/propertyRegistry.ts).

Unsupported names trigger an error whose message lists every supported name.

Backend: PUG-REST `/compound/cid/{cids}/property/{props}/JSON`.

---

## `get_compound_synonyms`

**Input**

| Field | Type | Default |
|---|---|---|
| `cid` | positive integer | required |
| `limit` | integer (1-500) | 50 |

Output: `{ cid, synonyms: string[], truncated: boolean, _meta }`.

Backend: PUG-REST `/compound/cid/{cid}/synonyms/JSON`.

---

## `get_compound_structure`

**Input**

| Field | Type | Default |
|---|---|---|
| `cid` | positive integer | required |
| `format` | enum `smiles`/`inchi`/`inchikey`/`sdf`/`json` | `smiles` |
| `recordType` | `2d` or `3d` (SDF only) | unset |

Output: `{ cid, format, content, contentType, truncated?, _meta }`. Both `sdf` and `json` content are bounded at **256 KB**; oversized responses are truncated and the result includes `truncated: true` plus a `_meta.warnings` entry indicating the original size. SMILES / InChI / InChIKey responses are small and not bounded.

Backend: PUG-REST property endpoint for SMILES/InChI/InChIKey, `/compound/cid/{cid}/SDF` for SDF, full record JSON for `json`.

---

## `search_structure`

Run an identity / similarity / substructure / superstructure search.

**Input**

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string | required | SMILES or InChI |
| `queryType` | `smiles`/`inchi` | required | |
| `searchType` | `identity`/`similarity_2d`/`substructure`/`superstructure` | required | |
| `threshold` | integer (0-100) | 90 | Only used for `similarity_2d` |
| `limit` | integer (1-100) | 25 | |

The server prefers the synchronous `fast*` variants. Async responses with `Waiting.ListKey` are polled (2s interval, up to 30 attempts). Each hit is enriched with `MolecularFormula`, `MolecularWeight`, `CanonicalSMILES`, and `InChIKey`.

Backend: PUG-REST structure search + property enrichment.

**InChI input**: when `queryType` is `inchi`, the server submits the search as `POST /compound/{operation}/inchi/cids/JSON` with a form-urlencoded `inchi=<value>` body — PubChem's documented channel. SMILES queries continue to use path-encoded GET.

Limitations: unbounded searches are not supported. `limit` is clamped at 100 to keep responses inside the MCP transport budget.

---

## `get_assay`

**Input**

| Field | Type | Default |
|---|---|---|
| `aid` | positive integer | required |
| `includeRaw` | boolean | `false` |

Output: normalized `AssaySummary` with optional `raw` when under 64 KB.

Backend: PUG-REST `/assay/aid/{aid}/summary/JSON`.

---

## `get_compound_assays`

**Input**

| Field | Type | Default |
|---|---|---|
| `cid` | positive integer | required |
| `limit` | integer (1-200) | 50 |

Output: `{ cid, aids: number[], truncated, _meta }`. If PubChem returns `404`, the tool surfaces a typed `not_found` error.

Backend: PUG-REST `/compound/cid/{cid}/aids/JSON`.

---

## `get_compound_annotations`

Retrieve curated annotation sections from PUG-View.

**Input**

| Field | Type | Default | Notes |
|---|---|---|---|
| `cid` | positive integer | required | |
| `heading` | string | unset | Case-insensitive substring match against TOC heading and its breadcrumb path |
| `maxSections` | integer (1-100) | 20 | |

Output: `{ cid, recordTitle, sections: AnnotationSection[], totalSections, truncated, _meta }`. Each section carries `heading`, `breadcrumb`, `texts[]`, and `references[]` derived from PubChem's record-level reference list.

Backend: PUG-View `/data/compound/{cid}/JSON?heading=...`.

**Important**: this returns PubChem-curated annotation text. It is source data, not the server's analysis. Do not treat it as medical/regulatory/lab-safety advice.

---

## `get_server_status`

No input. Returns:

```json
{
  "name": "pubchem-mcp",
  "version": "0.1.0",
  "uptimeSeconds": 123,
  "transport": "stdio",
  "pubchemBaseUrl": "https://pubchem.ncbi.nlm.nih.gov/rest/pug",
  "pubchemViewBaseUrl": "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view",
  "limits": { "rps": 4, "rpm": 240, "timeoutMs": 30000, "maxRetries": 4 },
  "cache": { "enabled": true, "ttlMs": 86400000, "maxEntries": 1000, "size": 0, "hits": 0, "misses": 0, "evictions": 0 },
  "throttle": { "status": "unknown" }
}
```

Useful for diagnosing rate-limit pressure (`throttle.status`) and cache hit rate.

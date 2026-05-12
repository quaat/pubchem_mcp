/**
 * URL builders for PubChem PUG-REST and PUG-View, plus the public
 * human-readable compound/assay pages.
 *
 * All builders return absolute URLs. Identifier values are URL-encoded.
 */

export const PUBCHEM_PUBLIC_BASE = 'https://pubchem.ncbi.nlm.nih.gov';

export type RestOutputFormat = 'JSON' | 'TXT' | 'SDF' | 'PNG' | 'XML' | 'CSV';

export interface UrlBuilderConfig {
  baseUrl: string;
  viewBaseUrl: string;
}

function enc(value: string | number): string {
  return encodeURIComponent(String(value));
}

function cidList(cids: ReadonlyArray<number>): string {
  if (cids.length === 0) throw new Error('cidList: at least one CID required');
  return cids.map((c) => enc(c)).join(',');
}

export function buildCompoundByCidPropertyUrl(
  cfg: UrlBuilderConfig,
  cids: ReadonlyArray<number>,
  properties: ReadonlyArray<string>,
  format: RestOutputFormat = 'JSON',
): string {
  if (properties.length === 0) throw new Error('properties must be non-empty');
  return `${cfg.baseUrl}/compound/cid/${cidList(cids)}/property/${properties.join(',')}/${format}`;
}

export function buildCompoundByNameCidsUrl(
  cfg: UrlBuilderConfig,
  name: string,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/name/${enc(name)}/cids/${format}`;
}

export function buildCompoundBySmilesCidsUrl(
  cfg: UrlBuilderConfig,
  smiles: string,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/smiles/${enc(smiles)}/cids/${format}`;
}

export function buildCompoundByInchiKeyCidsUrl(
  cfg: UrlBuilderConfig,
  inchiKey: string,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/inchikey/${enc(inchiKey)}/cids/${format}`;
}

/**
 * @deprecated Path-encoded InChI lookups are brittle for non-trivial InChI
 * strings. Prefer `buildCompoundByInchiCidsPostUrl` + POST form body.
 */
export function buildCompoundByInchiCidsUrl(
  cfg: UrlBuilderConfig,
  inchi: string,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/inchi/${enc(inchi)}/cids/${format}`;
}

/**
 * POST endpoint for InChI → CIDs. The InChI string is submitted as the
 * `inchi` field of an application/x-www-form-urlencoded body, which PubChem
 * documents as the supported channel for InChI input.
 */
export function buildCompoundByInchiCidsPostUrl(
  cfg: UrlBuilderConfig,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/inchi/cids/${format}`;
}

/**
 * POST endpoint for structure search by InChI. Use with form body `inchi=<value>`.
 * `searchType` selects the synchronous `fast*` variant by default.
 */
export function buildStructureSearchInchiPostUrl(
  cfg: UrlBuilderConfig,
  searchType: 'identity' | 'similarity_2d' | 'substructure' | 'superstructure',
  opts: { threshold?: number; maxRecords?: number; preferFast?: boolean } = {},
): string {
  const sync = opts.preferFast !== false;
  const op = (() => {
    switch (searchType) {
      case 'identity':
        return sync ? 'fastidentity' : 'identity';
      case 'similarity_2d':
        return sync ? 'fastsimilarity_2d' : 'similarity_2d';
      case 'substructure':
        return sync ? 'fastsubstructure' : 'substructure';
      case 'superstructure':
        return sync ? 'fastsuperstructure' : 'superstructure';
    }
  })();
  const params = new URLSearchParams();
  if (searchType === 'similarity_2d' && opts.threshold !== undefined) {
    params.set('Threshold', String(opts.threshold));
  }
  if (opts.maxRecords !== undefined) params.set('MaxRecords', String(opts.maxRecords));
  const qs = params.toString();
  const path = `${cfg.baseUrl}/compound/${op}/inchi/cids/JSON`;
  return qs ? `${path}?${qs}` : path;
}

export function buildCompoundByFormulaCidsUrl(
  cfg: UrlBuilderConfig,
  formula: string,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/fastformula/${enc(formula)}/cids/${format}`;
}

export function buildCompoundSynonymsUrl(
  cfg: UrlBuilderConfig,
  cid: number,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/cid/${enc(cid)}/synonyms/${format}`;
}

export function buildCompoundSdfUrl(
  cfg: UrlBuilderConfig,
  cid: number,
  recordType?: '2d' | '3d',
): string {
  const base = `${cfg.baseUrl}/compound/cid/${enc(cid)}/SDF`;
  return recordType ? `${base}?record_type=${recordType}` : base;
}

export function buildCompoundFullRecordUrl(
  cfg: UrlBuilderConfig,
  cid: number,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/cid/${enc(cid)}/${format}`;
}

export function buildCompoundAidsUrl(
  cfg: UrlBuilderConfig,
  cid: number,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/cid/${enc(cid)}/aids/${format}`;
}

export function buildAssaySummaryUrl(
  cfg: UrlBuilderConfig,
  aid: number,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/assay/aid/${enc(aid)}/summary/${format}`;
}

export interface StructureSearchUrlOpts {
  queryType: 'smiles' | 'inchi';
  searchType: 'identity' | 'similarity_2d' | 'substructure' | 'superstructure';
  query: string;
  /** Similarity threshold, only used for similarity searches. */
  threshold?: number;
  /** Max records to return — passed as `MaxRecords` query parameter. */
  maxRecords?: number;
  /** When true, force the synchronous (fast*) variant. */
  preferFast?: boolean;
}

export function buildStructureSearchUrl(
  cfg: UrlBuilderConfig,
  opts: StructureSearchUrlOpts,
): string {
  const sync = opts.preferFast !== false;
  let operation: string;
  switch (opts.searchType) {
    case 'identity':
      operation = sync ? 'fastidentity' : 'identity';
      break;
    case 'similarity_2d':
      operation = sync ? 'fastsimilarity_2d' : 'similarity_2d';
      break;
    case 'substructure':
      operation = sync ? 'fastsubstructure' : 'substructure';
      break;
    case 'superstructure':
      operation = sync ? 'fastsuperstructure' : 'superstructure';
      break;
  }
  const params = new URLSearchParams();
  if (opts.threshold !== undefined && opts.searchType === 'similarity_2d') {
    params.set('Threshold', String(opts.threshold));
  }
  if (opts.maxRecords !== undefined) {
    params.set('MaxRecords', String(opts.maxRecords));
  }
  const qs = params.toString();
  const path = `${cfg.baseUrl}/compound/${operation}/${opts.queryType}/${enc(opts.query)}/cids/JSON`;
  return qs ? `${path}?${qs}` : path;
}

export function buildListKeyPollUrl(
  cfg: UrlBuilderConfig,
  listKey: string,
  format: RestOutputFormat = 'JSON',
): string {
  return `${cfg.baseUrl}/compound/listkey/${enc(listKey)}/cids/${format}`;
}

export function buildPugViewCompoundUrl(
  cfg: UrlBuilderConfig,
  cid: number,
  heading?: string,
): string {
  const path = `${cfg.viewBaseUrl}/data/compound/${enc(cid)}/JSON`;
  if (!heading) return path;
  const params = new URLSearchParams({ heading });
  return `${path}?${params.toString()}`;
}

export function publicCompoundUrl(cid: number): string {
  return `${PUBCHEM_PUBLIC_BASE}/compound/${enc(cid)}`;
}

export function publicAssayUrl(aid: number): string {
  return `${PUBCHEM_PUBLIC_BASE}/bioassay/${enc(aid)}`;
}

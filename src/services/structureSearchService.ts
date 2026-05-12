import {
  PubChemNotFoundError,
  PubChemValidationError,
} from '../pubchem/pubchemErrors.js';
import type { StructureSearchResult } from '../pubchem/pubchemTypes.js';
import {
  buildCompoundByCidPropertyUrl,
  buildStructureSearchInchiPostUrl,
  buildStructureSearchSmilesPostUrl,
  buildStructureSearchUrl,
  publicCompoundUrl,
  shouldUseSmilesPost,
} from '../pubchem/pubchemUrls.js';
import { COMPACT_PROPERTIES } from '../pubchem/propertyRegistry.js';
import { normalizePropertyTable, type RawPropertyTable } from '../utils/normalize.js';
import { nowIso, type ServiceContext, urlConfig } from './serviceContext.js';

export interface SearchStructureInput {
  query: string;
  queryType: 'smiles' | 'inchi';
  searchType: 'identity' | 'similarity_2d' | 'substructure' | 'superstructure';
  threshold?: number;
  limit?: number;
}

interface WaitingOrList {
  Waiting?: { ListKey?: string };
  IdentifierList?: { CID?: number[] };
}

export class StructureSearchService {
  constructor(private readonly ctx: ServiceContext) {}

  async search(input: SearchStructureInput): Promise<StructureSearchResult> {
    const query = input.query.trim();
    if (!query) throw new PubChemValidationError('query must be non-empty');
    const threshold = input.threshold;
    if (threshold !== undefined && (threshold < 0 || threshold > 100)) {
      throw new PubChemValidationError('threshold must be between 0 and 100');
    }
    const limit = clamp(input.limit ?? 25, 1, 100);

    let body: WaitingOrList;
    if (input.queryType === 'inchi') {
      // PubChem requires POST/form-urlencoded for InChI structure searches.
      const url = buildStructureSearchInchiPostUrl(
        urlConfig(this.ctx.config),
        input.searchType,
        {
          ...(input.searchType === 'similarity_2d' ? { threshold: threshold ?? 90 } : {}),
          maxRecords: limit,
          preferFast: true,
        },
      );
      body = await this.ctx.rest.postFormJson<WaitingOrList>(url, { inchi: query });
    } else if (input.queryType === 'smiles' && shouldUseSmilesPost(query)) {
      // Complex SMILES → POST form body.
      const url = buildStructureSearchSmilesPostUrl(
        urlConfig(this.ctx.config),
        input.searchType,
        {
          ...(input.searchType === 'similarity_2d' ? { threshold: threshold ?? 90 } : {}),
          maxRecords: limit,
          preferFast: true,
        },
      );
      body = await this.ctx.rest.postFormJson<WaitingOrList>(url, { smiles: query });
    } else {
      const url = buildStructureSearchUrl(urlConfig(this.ctx.config), {
        queryType: input.queryType,
        searchType: input.searchType,
        query,
        ...(input.searchType === 'similarity_2d' ? { threshold: threshold ?? 90 } : {}),
        maxRecords: limit,
        preferFast: true,
      });
      body = await this.ctx.rest.getJson<WaitingOrList>(url);
    }

    let cids: number[] = [];
    let listKey: string | undefined;
    if (body.IdentifierList?.CID) {
      cids = body.IdentifierList.CID;
    } else if (body.Waiting?.ListKey) {
      listKey = body.Waiting.ListKey;
      cids = await this.ctx.rest.pollListKey(listKey, { intervalMs: 2_000, maxAttempts: 30 });
    } else {
      throw new PubChemNotFoundError('Structure search returned no results', {
        endpoint: 'compound/search',
      });
    }

    const totalHits = cids.length;
    const limited = cids.slice(0, limit);
    let hits: StructureSearchResult['hits'] = limited.map((cid) => ({
      cid,
      pubchemUrl: publicCompoundUrl(cid),
    }));

    if (limited.length > 0) {
      try {
        const propUrl = buildCompoundByCidPropertyUrl(
          urlConfig(this.ctx.config),
          limited,
          COMPACT_PROPERTIES,
        );
        const raw = await this.ctx.rest.getJson<RawPropertyTable>(propUrl);
        const enriched = normalizePropertyTable(raw);
        const byCid = new Map(enriched.map((c) => [c.cid, c]));
        hits = limited.map((cid) => {
          const c = byCid.get(cid);
          return {
            cid,
            pubchemUrl: publicCompoundUrl(cid),
            ...(c?.molecularFormula !== undefined ? { molecularFormula: c.molecularFormula } : {}),
            ...(c?.molecularWeight !== undefined ? { molecularWeight: c.molecularWeight } : {}),
            ...(c?.canonicalSmiles !== undefined ? { canonicalSmiles: c.canonicalSmiles } : {}),
            ...(c?.inchiKey !== undefined ? { inchiKey: c.inchiKey } : {}),
          };
        });
      } catch {
        // Property enrichment is best-effort; fall back to bare hits.
      }
    }

    return {
      query,
      queryType: input.queryType,
      searchType: input.searchType,
      ...(input.searchType === 'similarity_2d' ? { threshold: threshold ?? 90 } : {}),
      totalHits,
      hits,
      ...(listKey ? { listKey } : {}),
      _meta: {
        source: 'PubChem',
        backend: 'PUG-REST',
        retrievedAt: nowIso(),
        query: input,
      },
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

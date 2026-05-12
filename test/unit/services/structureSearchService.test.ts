import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { StructureSearchService } from '../../../src/services/structureSearchService.js';
import {
  installMswLifecycle,
  makeServiceContext,
  setupServer,
  TEST_BASE,
} from '../../helpers/serviceContext.js';
import { PubChemValidationError } from '../../../src/pubchem/pubchemErrors.js';

const server = setupServer();
installMswLifecycle(server);

describe('StructureSearchService', () => {
  it('runs a synchronous similarity search and enriches results', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/fastsimilarity_2d/smiles/CCO/cids/JSON`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('Threshold')).toBe('90');
        expect(url.searchParams.get('MaxRecords')).toBe('25');
        return HttpResponse.json({ IdentifierList: { CID: [702, 887] } });
      }),
      http.get(`${TEST_BASE}/compound/cid/702,887/property/*`, () =>
        HttpResponse.json({
          PropertyTable: {
            Properties: [
              { CID: 702, MolecularFormula: 'C2H6O', CanonicalSMILES: 'CCO' },
              { CID: 887, MolecularFormula: 'CH4O', CanonicalSMILES: 'CO' },
            ],
          },
        }),
      ),
    );
    const svc = new StructureSearchService(makeServiceContext());
    const r = await svc.search({
      query: 'CCO',
      queryType: 'smiles',
      searchType: 'similarity_2d',
    });
    expect(r.totalHits).toBe(2);
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]!.canonicalSmiles).toBe('CCO');
    expect(r.threshold).toBe(90);
  });

  it('rejects out-of-range threshold', async () => {
    const svc = new StructureSearchService(makeServiceContext());
    await expect(
      svc.search({ query: 'CCO', queryType: 'smiles', searchType: 'similarity_2d', threshold: 999 }),
    ).rejects.toBeInstanceOf(PubChemValidationError);
  });

  it('uses POST form body for InChI searches', async () => {
    let postBody: string | undefined;
    server.use(
      http.post(`${TEST_BASE}/compound/fastsubstructure/inchi/cids/JSON`, async ({ request }) => {
        postBody = await request.text();
        return HttpResponse.json({ IdentifierList: { CID: [2244] } });
      }),
      http.get(`${TEST_BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({
          PropertyTable: { Properties: [{ CID: 2244, MolecularFormula: 'C9H8O4' }] },
        }),
      ),
    );
    const svc = new StructureSearchService(makeServiceContext());
    const r = await svc.search({
      query: 'InChI=1S/C9H8O4',
      queryType: 'inchi',
      searchType: 'substructure',
    });
    expect(r.totalHits).toBe(1);
    expect(postBody).toMatch(/^inchi=InChI%3D1S/);
  });

  it('polls a ListKey for async searches', async () => {
    let polls = 0;
    server.use(
      http.get(`${TEST_BASE}/compound/fastsubstructure/smiles/c1ccccc1/cids/JSON`, () =>
        HttpResponse.json({ Waiting: { ListKey: 'lk-1' } }, { status: 202 }),
      ),
      http.get(`${TEST_BASE}/compound/listkey/lk-1/cids/JSON`, () => {
        polls += 1;
        if (polls < 2) return HttpResponse.json({ Waiting: { ListKey: 'lk-1' } }, { status: 202 });
        return HttpResponse.json({ IdentifierList: { CID: [241] } });
      }),
      http.get(`${TEST_BASE}/compound/cid/241/property/*`, () =>
        HttpResponse.json({
          PropertyTable: { Properties: [{ CID: 241, MolecularFormula: 'C6H6' }] },
        }),
      ),
    );
    const svc = new StructureSearchService(makeServiceContext());
    const r = await svc.search({
      query: 'c1ccccc1',
      queryType: 'smiles',
      searchType: 'substructure',
    });
    expect(r.totalHits).toBe(1);
    expect(r.listKey).toBe('lk-1');
  });
});

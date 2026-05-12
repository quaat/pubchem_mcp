import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { CompoundService } from '../../../src/services/compoundService.js';
import {
  installMswLifecycle,
  makeServiceContext,
  setupServer,
  TEST_BASE,
} from '../../helpers/serviceContext.js';
import { PubChemNotFoundError } from '../../../src/pubchem/pubchemErrors.js';

const server = setupServer();
installMswLifecycle(server);

describe('CompoundService.resolveCompound', () => {
  it('resolves a name to enriched candidates', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/name/aspirin/cids/JSON`, () =>
        HttpResponse.json({ IdentifierList: { CID: [2244] } }),
      ),
      http.get(`${TEST_BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({
          PropertyTable: {
            Properties: [
              {
                CID: 2244,
                MolecularFormula: 'C9H8O4',
                MolecularWeight: 180.16,
                CanonicalSMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O',
                IsomericSMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O',
                InChI: 'InChI=1S/C9H8O4',
                InChIKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
                IUPACName: '2-acetyloxybenzoic acid',
                Title: 'Aspirin',
              },
            ],
          },
        }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const result = await svc.resolveCompound({ query: 'aspirin' });
    expect(result.identifierType).toBe('name');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.cid).toBe(2244);
    expect(result.candidates[0]!.molecularFormula).toBe('C9H8O4');
    expect(result.candidates[0]!.pubchemUrl).toContain('/compound/2244');
  });

  it('auto-detects CID input and skips name lookup', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({
          PropertyTable: { Properties: [{ CID: 2244, MolecularFormula: 'C9H8O4' }] },
        }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const result = await svc.resolveCompound({ query: '2244', identifierType: 'auto' });
    expect(result.identifierType).toBe('cid');
    expect(result.candidates[0]!.cid).toBe(2244);
  });

  it('throws PubChemNotFoundError on empty results', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/name/quasicompoundium/cids/JSON`, () =>
        HttpResponse.json({ Fault: { Code: 404, Message: 'No CID found' } }, { status: 404 }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    await expect(svc.resolveCompound({ query: 'quasicompoundium' })).rejects.toBeInstanceOf(
      PubChemNotFoundError,
    );
  });

  it('honours limit and skips enrichment when includeProperties=false', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/name/aspirin/cids/JSON`, () =>
        HttpResponse.json({ IdentifierList: { CID: [2244, 5793, 962] } }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const result = await svc.resolveCompound({
      query: 'aspirin',
      limit: 2,
      includeProperties: false,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.molecularFormula).toBeUndefined();
  });
});

describe('CompoundService.resolveCompound InChI POST flow', () => {
  it('submits InChI as a POST form body, not in the URL path', async () => {
    let postBody: string | undefined;
    server.use(
      http.post(`${TEST_BASE}/compound/inchi/cids/JSON`, async ({ request }) => {
        postBody = await request.text();
        return HttpResponse.json({ IdentifierList: { CID: [2244] } });
      }),
      http.get(`${TEST_BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({
          PropertyTable: { Properties: [{ CID: 2244, MolecularFormula: 'C9H8O4' }] },
        }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const inchi =
      'InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)';
    const result = await svc.resolveCompound({ query: inchi, identifierType: 'inchi' });
    expect(result.candidates[0]!.cid).toBe(2244);
    expect(postBody).toMatch(/^inchi=InChI%3D1S/);
  });
});

describe('CompoundService.getCompound', () => {
  it('returns a normalized compound', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({
          PropertyTable: { Properties: [{ CID: 2244, MolecularFormula: 'C9H8O4', MolecularWeight: 180.16 }] },
        }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const c = await svc.getCompound({ cid: 2244 });
    expect(c.molecularFormula).toBe('C9H8O4');
    expect(c.molecularWeight).toBe(180.16);
    expect(c._meta.backend).toBe('PUG-REST');
  });

  it('includes raw when requested and small', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({ PropertyTable: { Properties: [{ CID: 2244 }] } }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const c = await svc.getCompound({ cid: 2244, includeRaw: true });
    expect(c.raw).toBeDefined();
  });
});

describe('CompoundService.getStructure', () => {
  it('returns SMILES via the property endpoint', async () => {
    server.use(
      http.get(`${TEST_BASE}/compound/cid/2244/property/CanonicalSMILES/JSON`, () =>
        HttpResponse.json({
          PropertyTable: { Properties: [{ CID: 2244, CanonicalSMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O' }] },
        }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const r = await svc.getStructure({ cid: 2244, format: 'smiles' });
    expect(r.content).toBe('CC(=O)OC1=CC=CC=C1C(=O)O');
    expect(r.contentType).toBe('text/plain');
  });

  it('bounds full-JSON record responses and flags truncation', async () => {
    // Build a fixture larger than 256KB.
    const bigArray = Array.from({ length: 5_000 }, (_, i) => ({
      idx: i,
      filler: 'x'.repeat(60),
    }));
    server.use(
      http.get(`${TEST_BASE}/compound/cid/2244/JSON`, () =>
        HttpResponse.json({ PC_Compounds: bigArray }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const r = await svc.getStructure({ cid: 2244, format: 'json' });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(256 * 1024);
    expect(r._meta.warnings?.[0]).toMatch(/truncated/);
  });

  it('returns SDF as text and flags truncation when oversized', async () => {
    const huge = 'X'.repeat(300 * 1024);
    server.use(
      http.get(`${TEST_BASE}/compound/cid/2244/SDF`, () =>
        new HttpResponse(huge, { status: 200, headers: { 'Content-Type': 'chemical/x-mdl-sdfile' } }),
      ),
    );
    const svc = new CompoundService(makeServiceContext());
    const r = await svc.getStructure({ cid: 2244, format: 'sdf', recordType: '2d' });
    expect(r.truncated).toBe(true);
    expect(r.recordType).toBe('2d');
  });
});

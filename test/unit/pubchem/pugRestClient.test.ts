import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import {
  PugRestClient,
  sanitizeEndpoint,
  type CachedEntry,
} from '../../../src/pubchem/pugRestClient.js';
import { TtlCache } from '../../../src/infrastructure/cache.js';
import { RateLimiter } from '../../../src/infrastructure/rateLimiter.js';
import { ThrottleStateTracker } from '../../../src/infrastructure/throttling.js';
import {
  PubChemNotFoundError,
  PubChemResponseError,
  PubChemTransientError,
  PubChemUnsupportedOperationError,
  PubChemValidationError,
} from '../../../src/pubchem/pubchemErrors.js';
import { loadConfig } from '../../../src/infrastructure/config.js';
import { createLogger } from '../../../src/infrastructure/logger.js';

const BASE = 'https://pubchem.test/rest/pug';
const VIEW = 'https://pubchem.test/rest/pug_view';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(extra?: { maxRetries?: number }) {
  const config = loadConfig({
    PUBCHEM_BASE_URL: BASE,
    PUBCHEM_VIEW_BASE_URL: VIEW,
    PUBCHEM_LOG_LEVEL: 'silent',
    PUBCHEM_TIMEOUT_MS: '5000',
    PUBCHEM_MAX_RETRIES: extra?.maxRetries !== undefined ? String(extra.maxRetries) : '4',
  } as NodeJS.ProcessEnv);
  return new PugRestClient({
    config,
    cache: new TtlCache({ ttlMs: 60_000, maxEntries: 100 }),
    logger: createLogger({ logLevel: 'silent' }),
    rateLimiter: new RateLimiter({ rps: 100, rpm: 240, sleep: async () => undefined }),
    throttle: new ThrottleStateTracker(),
    sleep: async () => undefined,
    random: () => 0.5,
    userAgentVersion: '0.0.0-test',
  });
}

describe('PugRestClient', () => {
  it('returns parsed JSON on 200', async () => {
    server.use(
      http.get(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`, () =>
        HttpResponse.json({ PropertyTable: { Properties: [{ CID: 2244, MolecularWeight: '180.16' }] } }),
      ),
    );
    const client = makeClient();
    const body = await client.getJson<{ PropertyTable: { Properties: { CID: number }[] } }>(
      `${BASE}/compound/cid/2244/property/MolecularWeight/JSON`,
    );
    expect(body.PropertyTable.Properties[0]!.CID).toBe(2244);
  });

  it('caches identical requests', async () => {
    let hits = 0;
    server.use(
      http.get(`${BASE}/compound/cid/2244/synonyms/JSON`, () => {
        hits += 1;
        return HttpResponse.json({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } });
      }),
    );
    const client = makeClient();
    await client.getJson(`${BASE}/compound/cid/2244/synonyms/JSON`);
    await client.getJson(`${BASE}/compound/cid/2244/synonyms/JSON`);
    expect(hits).toBe(1);
  });

  it('throws PubChemNotFoundError on 404', async () => {
    server.use(
      http.get(`${BASE}/compound/cid/9999999999/property/MolecularFormula/JSON`, () =>
        HttpResponse.json({ Fault: { Code: 404, Message: 'No CID found' } }, { status: 404 }),
      ),
    );
    const client = makeClient();
    await expect(
      client.getJson(`${BASE}/compound/cid/9999999999/property/MolecularFormula/JSON`),
    ).rejects.toBeInstanceOf(PubChemNotFoundError);
  });

  it('throws PubChemValidationError on 400 without retrying', async () => {
    let attempts = 0;
    server.use(
      http.get(`${BASE}/compound/smiles/bad/cids/JSON`, () => {
        attempts += 1;
        return HttpResponse.json({ Fault: { Code: 400, Message: 'Bad SMILES' } }, { status: 400 });
      }),
    );
    const client = makeClient();
    await expect(client.getJson(`${BASE}/compound/smiles/bad/cids/JSON`)).rejects.toBeInstanceOf(
      PubChemValidationError,
    );
    expect(attempts).toBe(1);
  });

  it('retries on 503 and eventually succeeds', async () => {
    let attempts = 0;
    server.use(
      http.get(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`, () => {
        attempts += 1;
        if (attempts < 3) {
          return new HttpResponse('busy', { status: 503 });
        }
        return HttpResponse.json({ PropertyTable: { Properties: [{ CID: 2244, MolecularWeight: 180.16 }] } });
      }),
    );
    const client = makeClient();
    const body = await client.getJson<{ PropertyTable: { Properties: { CID: number }[] } }>(
      `${BASE}/compound/cid/2244/property/MolecularWeight/JSON`,
    );
    expect(attempts).toBe(3);
    expect(body.PropertyTable.Properties[0]!.CID).toBe(2244);
  });

  it('gives up after exhausting retries on 503', async () => {
    let attempts = 0;
    server.use(
      http.get(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`, () => {
        attempts += 1;
        return new HttpResponse('still busy', { status: 503 });
      }),
    );
    const client = makeClient({ maxRetries: 2 });
    await expect(
      client.getJson(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`),
    ).rejects.toBeInstanceOf(PubChemTransientError);
    expect(attempts).toBe(2);
  });

  it('throws PubChemResponseError on invalid JSON', async () => {
    server.use(
      http.get(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`, () =>
        new HttpResponse('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    const client = makeClient();
    await expect(
      client.getJson(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`),
    ).rejects.toBeInstanceOf(PubChemResponseError);
  });

  it('returns SDF as text', async () => {
    server.use(
      http.get(`${BASE}/compound/cid/2244/SDF`, () =>
        new HttpResponse('  Mrv2014 ...\nMOL data', { status: 200, headers: { 'Content-Type': 'chemical/x-mdl-sdfile' } }),
      ),
    );
    const client = makeClient();
    const text = await client.getText(`${BASE}/compound/cid/2244/SDF`);
    expect(text).toContain('MOL data');
  });

  it('parses X-Throttling-Control into the tracker', async () => {
    const throttle = new ThrottleStateTracker();
    server.use(
      http.get(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`, () =>
        HttpResponse.json(
          { PropertyTable: { Properties: [{ CID: 2244 }] } },
          {
            headers: {
              'X-Throttling-Control':
                'Request Count status: Yellow (60%), Request Time status: Green (5%), Service status: Green (10%)',
            },
          },
        ),
      ),
    );
    const config = loadConfig({
      PUBCHEM_BASE_URL: BASE,
      PUBCHEM_VIEW_BASE_URL: VIEW,
      PUBCHEM_LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    const client = new PugRestClient({
      config,
      cache: new TtlCache({ ttlMs: 1000, maxEntries: 10 }),
      logger: createLogger({ logLevel: 'silent' }),
      rateLimiter: new RateLimiter({ rps: 100, rpm: 240, sleep: async () => undefined }),
      throttle,
      sleep: async () => undefined,
      userAgentVersion: '0.0.0-test',
    });
    await client.getJson(`${BASE}/compound/cid/2244/property/MolecularWeight/JSON`);
    expect(throttle.current()?.worstStatus).toBe('yellow');
    expect(throttle.current()?.requestCountPercent).toBe(60);
  });

  it('polls a ListKey to completion', async () => {
    let polls = 0;
    server.use(
      http.get(`${BASE}/compound/substructure/smiles/CCO/cids/JSON`, () =>
        HttpResponse.json({ Waiting: { ListKey: 'xyz' } }, { status: 202 }),
      ),
      http.get(`${BASE}/compound/listkey/xyz/cids/JSON`, async () => {
        polls += 1;
        if (polls < 2) {
          return HttpResponse.json({ Waiting: { ListKey: 'xyz' } }, { status: 202 });
        }
        await delay(0);
        return HttpResponse.json({ IdentifierList: { CID: [2244, 5793] } });
      }),
    );
    const client = makeClient();
    const initial = await client.getJson<{ Waiting?: { ListKey?: string } }>(
      `${BASE}/compound/substructure/smiles/CCO/cids/JSON`,
    );
    expect(initial.Waiting?.ListKey).toBe('xyz');
    const cids = await client.pollListKey('xyz', { intervalMs: 0, maxAttempts: 5 });
    expect(cids).toEqual([2244, 5793]);
  });

  it('maps 405 to PubChemUnsupportedOperationError', async () => {
    server.use(
      http.get(`${BASE}/compound/cid/2244/badop/JSON`, () =>
        new HttpResponse('method not allowed', { status: 405 }),
      ),
    );
    const client = makeClient();
    await expect(client.getJson(`${BASE}/compound/cid/2244/badop/JSON`)).rejects.toBeInstanceOf(
      PubChemUnsupportedOperationError,
    );
  });
});

describe('PugRestClient POST/form support', () => {
  it('sends an application/x-www-form-urlencoded body and parses JSON response', async () => {
    let receivedBody: string | undefined;
    let receivedContentType: string | undefined;
    server.use(
      http.post(`${BASE}/compound/inchi/cids/JSON`, async ({ request }) => {
        receivedContentType = request.headers.get('content-type') ?? undefined;
        receivedBody = await request.text();
        return HttpResponse.json({ IdentifierList: { CID: [2244] } });
      }),
    );
    const client = makeClient();
    const body = await client.postFormJson<{ IdentifierList: { CID: number[] } }>(
      `${BASE}/compound/inchi/cids/JSON`,
      { inchi: 'InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)' },
    );
    expect(body.IdentifierList.CID).toEqual([2244]);
    expect(receivedContentType).toContain('application/x-www-form-urlencoded');
    expect(receivedBody).toMatch(/^inchi=InChI%3D1S/);
  });

  it('parses X-Throttling-Control on POST responses', async () => {
    const throttle = new ThrottleStateTracker();
    server.use(
      http.post(`${BASE}/compound/inchi/cids/JSON`, () =>
        HttpResponse.json(
          { IdentifierList: { CID: [2244] } },
          {
            headers: {
              'X-Throttling-Control':
                'Request Count status: Red (80%), Service status: Green (10%)',
            },
          },
        ),
      ),
    );
    const config = loadConfig({
      PUBCHEM_BASE_URL: BASE,
      PUBCHEM_VIEW_BASE_URL: VIEW,
      PUBCHEM_LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    const client = new PugRestClient({
      config,
      cache: new TtlCache({ ttlMs: 1000, maxEntries: 10 }),
      logger: createLogger({ logLevel: 'silent' }),
      rateLimiter: new RateLimiter({ rps: 100, rpm: 240, sleep: async () => undefined }),
      throttle,
      sleep: async () => undefined,
      userAgentVersion: '0.0.0-test',
    });
    await client.postFormJson(`${BASE}/compound/inchi/cids/JSON`, { inchi: 'X' });
    expect(throttle.current()?.worstStatus).toBe('red');
  });

  it('retries POST on 503 then succeeds', async () => {
    let attempts = 0;
    server.use(
      http.post(`${BASE}/compound/inchi/cids/JSON`, () => {
        attempts += 1;
        if (attempts < 3) return new HttpResponse('busy', { status: 503 });
        return HttpResponse.json({ IdentifierList: { CID: [2244] } });
      }),
    );
    const client = makeClient();
    const body = await client.postFormJson<{ IdentifierList: { CID: number[] } }>(
      `${BASE}/compound/inchi/cids/JSON`,
      { inchi: 'X' },
    );
    expect(attempts).toBe(3);
    expect(body.IdentifierList.CID).toEqual([2244]);
  });

  it('maps POST 400 to PubChemValidationError without retry', async () => {
    let attempts = 0;
    server.use(
      http.post(`${BASE}/compound/inchi/cids/JSON`, () => {
        attempts += 1;
        return HttpResponse.json({ Fault: { Code: 400, Message: 'Bad InChI' } }, { status: 400 });
      }),
    );
    const client = makeClient();
    await expect(
      client.postFormJson(`${BASE}/compound/inchi/cids/JSON`, { inchi: 'bad' }),
    ).rejects.toBeInstanceOf(PubChemValidationError);
    expect(attempts).toBe(1);
  });

  it('maps POST 404 to PubChemNotFoundError', async () => {
    server.use(
      http.post(`${BASE}/compound/inchi/cids/JSON`, () =>
        HttpResponse.json({ Fault: { Code: 404, Message: 'No match' } }, { status: 404 }),
      ),
    );
    const client = makeClient();
    await expect(
      client.postFormJson(`${BASE}/compound/inchi/cids/JSON`, { inchi: 'X' }),
    ).rejects.toBeInstanceOf(PubChemNotFoundError);
  });

  it('does not read from cache on POST', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/compound/inchi/cids/JSON`, () => {
        calls += 1;
        return HttpResponse.json({ IdentifierList: { CID: [calls] } });
      }),
    );
    const client = makeClient();
    const a = await client.postFormJson<{ IdentifierList: { CID: number[] } }>(
      `${BASE}/compound/inchi/cids/JSON`,
      { inchi: 'X' },
    );
    const b = await client.postFormJson<{ IdentifierList: { CID: number[] } }>(
      `${BASE}/compound/inchi/cids/JSON`,
      { inchi: 'X' },
    );
    expect(a.IdentifierList.CID).toEqual([1]);
    expect(b.IdentifierList.CID).toEqual([2]);
    expect(calls).toBe(2);
  });
});

describe('PugRestClient cache.ttlMs override', () => {
  it('honors a per-request TTL override', async () => {
    let serves = 0;
    server.use(
      http.get(`${BASE}/compound/cid/2244/synonyms/JSON`, () => {
        serves += 1;
        return HttpResponse.json({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } });
      }),
    );
    const config = loadConfig({
      PUBCHEM_BASE_URL: BASE,
      PUBCHEM_VIEW_BASE_URL: VIEW,
      PUBCHEM_LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    let nowVal = 1_000_000;
    const cache = new TtlCache<CachedEntry>({
      ttlMs: 60_000,
      maxEntries: 100,
      now: () => nowVal,
    });
    const client = new PugRestClient({
      config,
      cache,
      logger: createLogger({ logLevel: 'silent' }),
      rateLimiter: new RateLimiter({ rps: 100, rpm: 240, sleep: async () => undefined }),
      throttle: new ThrottleStateTracker(),
      sleep: async () => undefined,
      userAgentVersion: '0.0.0-test',
    });
    await client.getJson(`${BASE}/compound/cid/2244/synonyms/JSON`, { cache: { ttlMs: 1_000 } });
    // Advance fake clock past the short per-request TTL.
    nowVal += 2_000;
    await client.getJson(`${BASE}/compound/cid/2244/synonyms/JSON`, { cache: { ttlMs: 1_000 } });
    expect(serves).toBe(2);
  });
});

describe('sanitizeEndpoint', () => {
  it('strips host and reduces to the first few path segments', () => {
    const cfg = { baseUrl: BASE, viewBaseUrl: VIEW };
    expect(sanitizeEndpoint(`${BASE}/compound/name/aspirin/cids/JSON`, cfg)).toBe(
      'compound/name/aspirin',
    );
    expect(sanitizeEndpoint(`${VIEW}/data/compound/2244/JSON?heading=Foo`, cfg)).toBe(
      'data/compound/2244',
    );
  });
});

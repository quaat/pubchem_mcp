import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server/createServer.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const BASE = 'https://pubchem.test/rest/pug';
const VIEW = 'https://pubchem.test/rest/pug_view';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

async function bootServer() {
  const config = loadConfig({
    PUBCHEM_BASE_URL: BASE,
    PUBCHEM_VIEW_BASE_URL: VIEW,
    PUBCHEM_LOG_LEVEL: 'silent',
    PUBCHEM_TIMEOUT_MS: '5000',
    PUBCHEM_MAX_RETRIES: '1',
  } as NodeJS.ProcessEnv);
  const logger = createLogger({ logLevel: 'silent' });
  const created = createServer({ config, logger, sleep: async () => undefined });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, created };
}

function parseToolResult(result: { content: unknown }): unknown {
  const arr = (result.content as Array<{ type: string; text?: string }>) ?? [];
  const text = arr[0]?.text ?? '';
  return JSON.parse(text);
}

describe('MCP server end-to-end', () => {
  it('lists all expected tools', async () => {
    const { client } = await bootServer();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'get_assay',
        'get_compound',
        'get_compound_annotations',
        'get_compound_assays',
        'get_compound_properties',
        'get_compound_structure',
        'get_compound_synonyms',
        'get_server_status',
        'resolve_compound',
        'search_structure',
      ].sort(),
    );
  });

  it('resolve_compound returns enriched candidates', async () => {
    mock.use(
      http.get(`${BASE}/compound/name/aspirin/cids/JSON`, () =>
        HttpResponse.json({ IdentifierList: { CID: [2244] } }),
      ),
      http.get(`${BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({
          PropertyTable: {
            Properties: [
              { CID: 2244, MolecularFormula: 'C9H8O4', MolecularWeight: 180.16, Title: 'Aspirin' },
            ],
          },
        }),
      ),
    );
    const { client } = await bootServer();
    const result = await client.callTool({
      name: 'resolve_compound',
      arguments: { query: 'aspirin' },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result as { content: unknown }) as {
      candidates: { cid: number; molecularFormula?: string }[];
    };
    expect(parsed.candidates[0]!.cid).toBe(2244);
  });

  it('returns isError on invalid CID input', async () => {
    const { client } = await bootServer();
    const result = await client.callTool({
      name: 'get_compound',
      arguments: { cid: -1 },
    });
    expect(result.isError).toBe(true);
  });

  it('get_compound_properties rejects unsupported property names with typed validation error', async () => {
    const { client } = await bootServer();
    const result = await client.callTool({
      name: 'get_compound_properties',
      arguments: { cids: [2244], properties: ['LethalDose'] },
    });
    expect(result.isError).toBe(true);
    const payload = parseToolResult(result as { content: unknown }) as {
      error: string;
      category?: string;
      retryable?: boolean;
      endpoint?: string;
    };
    expect(payload.error).toMatch(/Unsupported property/);
    expect(payload.category).toBe('validation');
    expect(payload.retryable).toBe(false);
    expect(payload.endpoint).toBeDefined();
  });

  it('get_server_status reports diagnostics including configured limits', async () => {
    const { client } = await bootServer();
    const result = await client.callTool({ name: 'get_server_status', arguments: {} });
    const payload = parseToolResult(result as { content: unknown }) as {
      version: string;
      limits: { rps: number; rpm: number };
      transport: string;
    };
    expect(payload.version).toBe('0.1.0');
    expect(payload.transport).toBe('stdio');
    expect(payload.limits.rps).toBe(4);
  });

  it('reads resource pubchem://compound/{cid}', async () => {
    mock.use(
      http.get(`${BASE}/compound/cid/2244/property/*`, () =>
        HttpResponse.json({ PropertyTable: { Properties: [{ CID: 2244, MolecularFormula: 'C9H8O4' }] } }),
      ),
    );
    const { client } = await bootServer();
    const r = await client.readResource({ uri: 'pubchem://compound/2244' });
    expect(r.contents[0]?.mimeType).toBe('application/json');
    const text = (r.contents[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.cid).toBe(2244);
    expect(parsed.molecularFormula).toBe('C9H8O4');
  });

  it('reads resource pubchem://compound/{cid}/synonyms', async () => {
    mock.use(
      http.get(`${BASE}/compound/cid/2244/synonyms/JSON`, () =>
        HttpResponse.json({
          InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin', 'acetylsalicylic acid'] }] },
        }),
      ),
    );
    const { client } = await bootServer();
    const r = await client.readResource({ uri: 'pubchem://compound/2244/synonyms' });
    const parsed = JSON.parse((r.contents[0] as { text: string }).text);
    expect(parsed.synonyms).toContain('aspirin');
  });

  it('reads resource pubchem://assay/{aid}', async () => {
    mock.use(
      http.get(`${BASE}/assay/aid/1259357/summary/JSON`, () =>
        HttpResponse.json({
          AssaySummaries: { AssaySummary: [{ AID: 1259357, Name: 'CYP3A4 inhibition' }] },
        }),
      ),
    );
    const { client } = await bootServer();
    const r = await client.readResource({ uri: 'pubchem://assay/1259357' });
    const parsed = JSON.parse((r.contents[0] as { text: string }).text);
    expect(parsed.aid).toBe(1259357);
    expect(parsed.name).toContain('CYP3A4');
  });

  it('lists all 3 prompts', async () => {
    const { client } = await bootServer();
    const r = await client.listPrompts();
    const names = r.prompts.map((p) => p.name).sort();
    expect(names).toEqual(['compare-compounds', 'compound-research-brief', 'safety-annotation-review']);
  });

  it('getPrompt returns instruction text', async () => {
    const { client } = await bootServer();
    const r = await client.getPrompt({
      name: 'compound-research-brief',
      arguments: { compound: 'aspirin' },
    });
    expect(r.messages[0]?.content.type).toBe('text');
    const text = (r.messages[0]?.content as { type: 'text'; text: string }).text;
    expect(text).toMatch(/PubChem/);
    expect(text).toMatch(/aspirin/);
  });

  it('annotations tool returns structured sections with provenance', async () => {
    mock.use(
      http.get(`${VIEW}/data/compound/2244/JSON`, () =>
        HttpResponse.json({
          Record: {
            RecordTitle: 'Aspirin',
            Reference: [{ ReferenceNumber: 1, SourceName: 'DrugBank' }],
            Section: [
              {
                TOCHeading: 'Pharmacology',
                Section: [
                  {
                    TOCHeading: 'Mechanism of Action',
                    Information: [
                      {
                        ReferenceNumber: 1,
                        Value: { StringWithMarkup: [{ String: 'Inhibits COX enzymes.' }] },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
    const { client } = await bootServer();
    const result = await client.callTool({
      name: 'get_compound_annotations',
      arguments: { cid: 2244 },
    });
    const payload = parseToolResult(result as { content: unknown }) as {
      sections: { heading: string; references: { sourceName?: string }[]; texts: string[] }[];
    };
    expect(payload.sections[0]?.references[0]?.sourceName).toBe('DrugBank');
    expect(payload.sections[0]?.texts[0]).toContain('COX');
  });
});

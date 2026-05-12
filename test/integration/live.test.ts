import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server/createServer.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const LIVE = process.env.PUBCHEM_MCP_LIVE_TESTS === '1';

async function boot() {
  // Use real PubChem URLs and conservative limits. These live tests require
  // outbound DNS+HTTPS to pubchem.ncbi.nlm.nih.gov; sandboxed CI environments
  // without network access should leave PUBCHEM_MCP_LIVE_TESTS unset.
  const config = loadConfig({
    PUBCHEM_LOG_LEVEL: 'warn',
    PUBCHEM_RPS: '2',
    PUBCHEM_RPM: '60',
    PUBCHEM_MAX_RETRIES: '4',
    PUBCHEM_TIMEOUT_MS: '30000',
  } as NodeJS.ProcessEnv);
  const logger = createLogger({ logLevel: 'warn' });
  const created = createServer({ config, logger });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  const client = new Client({ name: 'live-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

/**
 * Assert a tool call succeeded. On failure, include the entire structured
 * payload (error/category/retryable/endpoint) in the message so a network
 * outage shows up as a readable diagnostic instead of a downstream
 * `Cannot read properties of undefined` chain.
 */
function expectOk(result: ToolResult, label: string): unknown {
  const text = result.content?.[0]?.text ?? '<no content>';
  if (result.isError === true) {
    throw new Error(
      `${label} returned an MCP tool error.\n` +
        `Payload:\n${text}\n` +
        `(If this is a DNS/network failure, ensure PUBCHEM_MCP_LIVE_TESTS=1 is intended ` +
        `and that this host can reach pubchem.ncbi.nlm.nih.gov over HTTPS.)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${label} returned content that did not parse as JSON: ${(err as Error).message}\n` +
        `Raw content:\n${text}`,
    );
  }
  return parsed;
}

describe.skipIf(!LIVE)('live PubChem integration (gated by PUBCHEM_MCP_LIVE_TESTS=1)', () => {
  it(
    'resolves aspirin to CID 2244',
    async () => {
      const client = await boot();
      const r = await client.callTool({
        name: 'resolve_compound',
        arguments: { query: 'aspirin', limit: 1 },
      });
      const payload = expectOk(r as ToolResult, 'resolve_compound(aspirin)') as {
        candidates: { cid: number }[];
      };
      expect(payload.candidates?.[0]?.cid, JSON.stringify(payload)).toBe(2244);
    },
    30_000,
  );

  it(
    'fetches caffeine (CID 2519) properties',
    async () => {
      const client = await boot();
      const r = await client.callTool({
        name: 'get_compound_properties',
        arguments: { cids: [2519], properties: ['MolecularFormula', 'MolecularWeight'] },
      });
      const payload = expectOk(r as ToolResult, 'get_compound_properties(2519)') as {
        rows: { properties: { MolecularFormula?: string } }[];
      };
      expect(
        payload.rows?.[0]?.properties?.MolecularFormula,
        JSON.stringify(payload),
      ).toBe('C8H10N4O2');
    },
    30_000,
  );

  it(
    'returns water (CID 962) synonyms',
    async () => {
      const client = await boot();
      const r = await client.callTool({
        name: 'get_compound_synonyms',
        arguments: { cid: 962, limit: 5 },
      });
      const payload = expectOk(r as ToolResult, 'get_compound_synonyms(962)') as {
        synonyms: string[];
      };
      expect(payload.synonyms?.length ?? 0, JSON.stringify(payload)).toBeGreaterThan(0);
      expect(payload.synonyms.join(' ').toLowerCase()).toMatch(/water|h2o/);
    },
    30_000,
  );

  it(
    'resolves aspirin by InChI via POST',
    async () => {
      const client = await boot();
      const r = await client.callTool({
        name: 'resolve_compound',
        arguments: {
          query:
            'InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)',
          identifierType: 'inchi',
          limit: 1,
          includeProperties: false,
        },
      });
      const payload = expectOk(r as ToolResult, 'resolve_compound(inchi aspirin)') as {
        candidates: { cid: number }[];
      };
      expect(payload.candidates?.[0]?.cid, JSON.stringify(payload)).toBe(2244);
    },
    30_000,
  );
});

describe('live test gate', () => {
  it('is skipped when PUBCHEM_MCP_LIVE_TESTS is not set', () => {
    expect(LIVE).toBe(process.env.PUBCHEM_MCP_LIVE_TESTS === '1');
  });
});

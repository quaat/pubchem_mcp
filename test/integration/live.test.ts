import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server/createServer.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const LIVE = process.env.PUBCHEM_MCP_LIVE_TESTS === '1';

interface LiveHandle {
  client: Client;
  close: () => Promise<void>;
}

async function boot(): Promise<LiveHandle> {
  // Live tests use real PubChem URLs but a deliberately constrained config so
  // a DNS/network-denied environment completes promptly with a typed transient
  // error rather than hanging on long timeouts and retries.
  //
  // Outbound DNS+HTTPS to pubchem.ncbi.nlm.nih.gov is required for these tests
  // to pass; otherwise expect a `category: transient` tool error within a few
  // seconds.
  // Merge process.env so manual overrides (e.g. PUBCHEM_BASE_URL=pubchem.invalid
  // to verify the controlled-failure path) take effect, but provide tight
  // defaults so the suite doesn't hang when network is denied.
  const config = loadConfig({
    PUBCHEM_LOG_LEVEL: 'warn',
    PUBCHEM_RPS: '2',
    PUBCHEM_RPM: '60',
    PUBCHEM_MAX_RETRIES: '2',
    PUBCHEM_TIMEOUT_MS: '10000',
    ...process.env,
  } as NodeJS.ProcessEnv);
  const logger = createLogger({ logLevel: 'warn' });
  const created = createServer({ config, logger });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  const client = new Client({ name: 'live-test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  const close = async () => {
    // Order matters: close the client first so the server sees the disconnect
    // and stops awaiting any pending requests.
    await client.close().catch(() => undefined);
    await created.server.close().catch(() => undefined);
    await clientTransport.close().catch(() => undefined);
    await serverTransport.close().catch(() => undefined);
  };
  return { client, close };
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
        `and that this host can reach pubchem.ncbi.nlm.nih.gov over HTTPS. ` +
        `Transport failures are reported as { category: "transient", retryable: true } ` +
        `with a sanitized endpoint label.)`,
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

/**
 * Run a live test against a fresh MCP server pair, guaranteeing transport
 * cleanup. This prevents hung connections when network is unavailable.
 */
async function withLive(fn: (client: Client) => Promise<void>): Promise<void> {
  const handle = await boot();
  try {
    await fn(handle.client);
  } finally {
    await handle.close();
  }
}

describe.skipIf(!LIVE)('live PubChem integration (gated by PUBCHEM_MCP_LIVE_TESTS=1)', () => {
  it(
    'resolves aspirin to CID 2244',
    () =>
      withLive(async (client) => {
        const r = await client.callTool({
          name: 'resolve_compound',
          arguments: { query: 'aspirin', limit: 1 },
        });
        const payload = expectOk(r as ToolResult, 'resolve_compound(aspirin)') as {
          candidates: { cid: number }[];
        };
        expect(payload.candidates?.[0]?.cid, JSON.stringify(payload)).toBe(2244);
      }),
    30_000,
  );

  it(
    'fetches caffeine (CID 2519) properties',
    () =>
      withLive(async (client) => {
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
      }),
    30_000,
  );

  it(
    'returns water (CID 962) synonyms',
    () =>
      withLive(async (client) => {
        const r = await client.callTool({
          name: 'get_compound_synonyms',
          arguments: { cid: 962, limit: 5 },
        });
        const payload = expectOk(r as ToolResult, 'get_compound_synonyms(962)') as {
          synonyms: string[];
        };
        expect(payload.synonyms?.length ?? 0, JSON.stringify(payload)).toBeGreaterThan(0);
        expect(payload.synonyms.join(' ').toLowerCase()).toMatch(/water|h2o/);
      }),
    30_000,
  );

  it(
    'resolves aspirin by InChI via POST',
    () =>
      withLive(async (client) => {
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
      }),
    30_000,
  );
});

describe('live test gate', () => {
  it('is skipped when PUBCHEM_MCP_LIVE_TESTS is not set', () => {
    expect(LIVE).toBe(process.env.PUBCHEM_MCP_LIVE_TESTS === '1');
  });
});

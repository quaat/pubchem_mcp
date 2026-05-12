import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../infrastructure/config.js';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import { TtlCache } from '../infrastructure/cache.js';
import { RateLimiter } from '../infrastructure/rateLimiter.js';
import { ThrottleStateTracker } from '../infrastructure/throttling.js';
import { PugRestClient, type CachedEntry } from '../pubchem/pugRestClient.js';
import { PugViewClient } from '../pubchem/pugViewClient.js';
import type { ServiceContext } from '../services/serviceContext.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { PACKAGE_VERSION } from '../version.js';

export { PACKAGE_VERSION };

export interface CreateServerOptions {
  config: Config;
  logger?: Logger;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  /** Inject for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CreatedServer {
  server: McpServer;
  ctx: ServiceContext;
  cache: TtlCache<CachedEntry>;
  throttle: ThrottleStateTracker;
  startedAt: number;
}

export function createServer(opts: CreateServerOptions): CreatedServer {
  const logger = opts.logger ?? createLogger(opts.config);
  const cache = new TtlCache<CachedEntry>({
    ttlMs: opts.config.cacheTtlMs,
    maxEntries: opts.config.cacheMaxEntries,
    disabled: opts.config.cacheDisabled,
  });
  const rateLimiter = new RateLimiter({
    rps: opts.config.rps,
    rpm: opts.config.rpm,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  const throttle = new ThrottleStateTracker();
  const rest = new PugRestClient({
    config: opts.config,
    cache,
    logger,
    rateLimiter,
    throttle,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    userAgentVersion: PACKAGE_VERSION,
  });
  const view = new PugViewClient({
    config: opts.config,
    cache,
    logger,
    rateLimiter,
    throttle,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    userAgentVersion: PACKAGE_VERSION,
  });

  const ctx: ServiceContext = { config: opts.config, logger, rest, view };
  const startedAt = Date.now();

  const server = new McpServer({ name: 'pubchem-mcp', version: PACKAGE_VERSION });

  registerTools(server, { ctx, cache, throttle, startedAt, packageVersion: PACKAGE_VERSION });
  registerResources(server, ctx);
  registerPrompts(server);

  return { server, ctx, cache, throttle, startedAt };
}

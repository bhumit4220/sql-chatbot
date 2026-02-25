/**
 * Middleware discovery — finds the chatbot agent endpoint for the current site.
 *
 * Flow:
 * 1. Check chrome.storage.local for cached endpoint (24h TTL)
 * 2. Check <meta name="chatbot-agent" content="..."> in DOM
 * 3. Fetch /.well-known/chatbot-agent.json
 * 4. If found → cache and return
 * 5. If not → return null
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface DiscoveryResult {
  endpoint: string;
  source: 'cache' | 'meta' | 'well-known' | 'manual';
}

interface SiteConfig {
  endpoint: string;
  discoveredAt: number;
}

export interface DiscoveryOptions {
  /** Override DOM meta tag query (for testing without jsdom). */
  queryMetaTag?: () => string | null;
}

function cacheKey(origin: string): string {
  return `site:${origin}`;
}

function resolveEndpoint(origin: string, raw: string): string {
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw;
  }
  // Relative path — prepend origin
  return `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

async function getCachedConfig(origin: string): Promise<SiteConfig | null> {
  const key = cacheKey(origin);
  const result = await chrome.storage.local.get([key]);
  const config = result[key] as SiteConfig | undefined;
  if (!config) return null;

  // Check TTL
  if (Date.now() - config.discoveredAt > CACHE_TTL_MS) {
    return null; // expired
  }
  return config;
}

async function cacheConfig(origin: string, endpoint: string): Promise<void> {
  const key = cacheKey(origin);
  await chrome.storage.local.set({
    [key]: { endpoint, discoveredAt: Date.now() } satisfies SiteConfig,
  });
}

function defaultQueryMetaTag(): string | null {
  try {
    const meta = document.querySelector('meta[name="chatbot-agent"]');
    return meta?.getAttribute('content') ?? null;
  } catch {
    return null;
  }
}

async function fetchWellKnown(origin: string): Promise<string | null> {
  try {
    const response = await fetch(`${origin}/.well-known/chatbot-agent.json`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Discover the chatbot middleware endpoint for the given origin.
 * Returns null if no middleware is found on this site.
 */
export async function discoverMiddleware(
  origin: string,
  options?: DiscoveryOptions
): Promise<DiscoveryResult | null> {
  // 1. Check cache
  const cached = await getCachedConfig(origin);
  if (cached) {
    return { endpoint: cached.endpoint, source: 'cache' };
  }

  // 2. Check meta tag
  const queryMeta = options?.queryMetaTag ?? defaultQueryMetaTag;
  const metaContent = queryMeta();
  if (metaContent) {
    const endpoint = resolveEndpoint(origin, metaContent);
    await cacheConfig(origin, endpoint);
    return { endpoint, source: 'meta' };
  }

  // 3. Check .well-known
  const wellKnownEndpoint = await fetchWellKnown(origin);
  if (wellKnownEndpoint) {
    const endpoint = resolveEndpoint(origin, wellKnownEndpoint);
    await cacheConfig(origin, endpoint);
    return { endpoint, source: 'well-known' };
  }

  // 4. Not found
  return null;
}

/**
 * Clear the cached discovery result for an origin.
 */
export async function clearDiscoveryCache(origin: string): Promise<void> {
  await chrome.storage.local.remove(cacheKey(origin));
}

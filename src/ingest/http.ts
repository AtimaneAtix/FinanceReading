import { ProxyAgent, type Dispatcher } from 'undici';

export const USER_AGENT =
  process.env.USER_AGENT ??
  'FinanceReadingBot/0.1 (personal research reader; +https://github.com/AtimaneAtix/FinanceReading)';

const DEFAULT_TIMEOUT_MS = 20_000;

let dispatcher: Dispatcher | null | undefined;
/**
 * Node's fetch ignores HTTPS_PROXY unless told otherwise. Honouring it matters
 * for running inside a corporate or sandboxed network.
 */
function proxyDispatcher(url: string): Dispatcher | undefined {
  if (dispatcher === undefined) {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    dispatcher = proxy ? new ProxyAgent(proxy) : null;
  }
  if (dispatcher === null) return undefined;
  return shouldProxy(url) ? dispatcher : undefined;
}

/**
 * Decides whether one URL goes through the proxy.
 *
 * NO_PROXY is not optional politeness: a proxy asked to reach localhost or a
 * private address answers 403, so ignoring the list breaks every local and
 * intranet request while looking like the remote host refused.
 */
export function shouldProxy(url: string, noProxyEnv = process.env.NO_PROXY ?? process.env.no_proxy): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  // Loopback never goes through a proxy, whatever the environment says.
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false;
  if (/^127\./.test(host)) return false;

  for (const raw of (noProxyEnv ?? '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry === '*') return false;
    if (entry.includes('/')) {
      if (inCidr(host, entry)) return false;
      continue;
    }
    const bare = entry.startsWith('.') ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) return false;
  }
  return true;
}

function inCidr(host: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!network || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const hostInt = ipv4ToInt(host);
  const networkInt = ipv4ToInt(network);
  if (hostInt === null || networkInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (hostInt & mask) === (networkInt & mask);
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  notModified: boolean;
  body: string;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
}

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Sent as If-None-Match / If-Modified-Since to make an unchanged fetch free. */
  etag?: string | null;
  lastModified?: string | null;
  accept?: string;
}

export async function httpFetch(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en',
    ...opts.headers,
  };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

  const init: RequestInit & { dispatcher?: Dispatcher } = {
    method: opts.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    redirect: 'follow',
  };
  if (opts.body !== undefined) init.body = opts.body;
  const d = proxyDispatcher(url);
  if (d) init.dispatcher = d;

  let res: Response;
  try {
    res = await fetch(url, init as RequestInit);
  } catch (err) {
    // Node collapses every transport problem into "fetch failed" and hides the
    // reason in `cause`. Unwrapping it is the difference between a user seeing
    // "fetch failed" and seeing "DNS lookup failed" or "blocked by a proxy".
    throw new Error(`${describeFetchFailure(err)} (${url})`, { cause: err });
  }
  // 304 carries no body, and reading one would just block until timeout.
  const body = res.status === 304 ? '' : await res.text();

  return {
    status: res.status,
    ok: res.ok,
    notModified: res.status === 304,
    body,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    finalUrl: res.url || url,
  };
}

/** Messages that describe the wrapper rather than the problem. */
const UNINFORMATIVE = [/^fetch failed$/i, /^request was cancelled\.?$/i, /^terminated$/i];

const CODE_MEANINGS: Record<string, string> = {
  ENOTFOUND: 'DNS lookup failed — check the hostname, or the network',
  EAI_AGAIN: 'DNS lookup failed — check the hostname, or the network',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by the server',
  ETIMEDOUT: 'Connection timed out',
  CERT_HAS_EXPIRED: 'TLS certificate has expired',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate is self-signed and not trusted',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed and not trusted',
};

/**
 * Turns an opaque fetch rejection into something worth reading.
 *
 * Node reports every transport problem as "fetch failed" and buries the real
 * reason two or three `cause` levels down — a proxy refusing to tunnel arrives
 * as "fetch failed" wrapping "Request was cancelled." wrapping the only
 * sentence that matters. Reporting the top-level message would tell the reader
 * nothing at the exact moment they need to know whether a source is dead, the
 * URL is wrong, or their own network is in the way.
 */
export function describeFetchFailure(err: unknown): string {
  const chain: { name?: string; message?: string; code?: string }[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth++) {
    const node = current as { name?: string; message?: string; code?: string; cause?: unknown };
    chain.push({ name: node.name, message: node.message, code: node.code });
    current = node.cause;
  }

  const proxy = chain.find((e) => /Proxy response \((\d+)\)/i.test(e.message ?? ''));
  if (proxy) {
    const status = /Proxy response \((\d+)\)/i.exec(proxy.message ?? '')?.[1];
    return `Blocked by the network proxy (HTTP ${status ?? '?'}) before reaching the site`;
  }

  if (chain.some((e) => e.name === 'TimeoutError' || e.name === 'AbortError')) {
    // An abort with no proxy message is our own timeout firing.
    const aborted = chain.find((e) => e.name === 'TimeoutError');
    if (aborted || chain.every((e) => e.code !== 'UND_ERR_ABORTED')) {
      return 'Timed out waiting for a response';
    }
  }

  for (const entry of chain) {
    if (entry.code && CODE_MEANINGS[entry.code]) return CODE_MEANINGS[entry.code] as string;
  }

  // Deepest informative message wins: the outer layers are wrappers.
  for (const entry of [...chain].reverse()) {
    const message = entry.message?.trim();
    if (message && !UNINFORMATIVE.some((re) => re.test(message))) return message;
  }
  return 'Request failed for an unknown reason';
}

// --- politeness ------------------------------------------------------------

const MIN_GAP_MS = Number(process.env.HOST_MIN_GAP_MS ?? 1000);
const lastRequestAt = new Map<string, number>();
const hostQueue = new Map<string, Promise<void>>();

/**
 * Serialises requests per host and keeps at least MIN_GAP_MS between them, so
 * a sitemap run that visits 25 article pages behaves like a person reading
 * rather than a crawler.
 */
export async function throttled<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = safeHost(url);
  const previous = hostQueue.get(host) ?? Promise.resolve();

  let release!: () => void;
  const turn = new Promise<void>((r) => (release = r));
  hostQueue.set(host, previous.then(() => turn));

  await previous;
  try {
    const gap = Date.now() - (lastRequestAt.get(host) ?? 0);
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
    lastRequestAt.set(host, Date.now());
    return await fn();
  } finally {
    release();
    // Avoid leaking one promise chain per host forever.
    if (hostQueue.get(host) === turn) hostQueue.delete(host);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// --- robots.txt ------------------------------------------------------------

interface RobotsRules {
  disallow: string[];
  allow: string[];
}

/** robots.txt changes; a worker that runs for weeks must not cache it forever. */
const ROBOTS_TTL_MS = 12 * 60 * 60 * 1000;
const robotsCache = new Map<string, { rules: RobotsRules | null; fetchedAt: number }>();

/** Exposed for tests, which need each case to start from a clean slate. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

/**
 * A deliberately small robots.txt reader: it honours Allow and Disallow for
 * our user-agent and for `*`, with longest-match-wins, which is the part that
 * actually governs whether we may read a page.
 *
 * A robots.txt we cannot fetch is treated as permissive, matching how
 * mainstream crawlers behave for a 404.
 */
export async function robotsAllows(url: string): Promise<boolean> {
  if (process.env.IGNORE_ROBOTS === '1') return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = parsed.origin;

  const cached = robotsCache.get(origin);
  if (!cached || Date.now() - cached.fetchedAt > ROBOTS_TTL_MS) {
    robotsCache.set(origin, { rules: await loadRobots(origin), fetchedAt: Date.now() });
  }
  const rules = robotsCache.get(origin)?.rules ?? null;
  if (!rules) return true;

  const path = parsed.pathname + parsed.search;
  const longest = (patterns: string[]): number =>
    patterns.reduce((best, p) => (pathMatches(path, p) ? Math.max(best, p.length) : best), -1);

  const allow = longest(rules.allow);
  const disallow = longest(rules.disallow);
  if (disallow < 0) return true;
  return allow >= disallow;
}

async function loadRobots(origin: string): Promise<RobotsRules | null> {
  try {
    const res = await throttled(origin, () =>
      httpFetch(`${origin}/robots.txt`, { timeoutMs: 10_000, accept: 'text/plain' }),
    );
    if (!res.ok) return null;
    return parseRobots(res.body);
  } catch {
    return null;
  }
}

export function parseRobots(text: string, agent = 'financereadingbot'): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] };
  const groups: { agents: string[]; disallow: string[]; allow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastLineWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;
    if (field === 'disallow' && value !== '') current.disallow.push(value);
    else if (field === 'allow' && value !== '') current.allow.push(value);
  }

  const specific = groups.filter((g) => g.agents.some((a) => a === agent));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  for (const g of specific.length > 0 ? specific : wildcard) {
    rules.disallow.push(...g.disallow);
    rules.allow.push(...g.allow);
  }
  return rules;
}

/** robots.txt path matching, including `*` wildcards and a `$` end anchor. */
export function pathMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

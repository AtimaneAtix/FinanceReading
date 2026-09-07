import { existsSync } from 'node:fs';
import { extractFromHtml } from './html.ts';
import { USER_AGENT } from '../http.ts';
import { AdapterError, type AdapterContext, type AdapterResult } from './types.ts';

type BrowserConfig = Extract<import('../../config.ts').AdapterConfig, { kind: 'browser' }>;

/**
 * Playwright is an optional dependency and Chromium is a large download, so it
 * is imported only when a source actually needs rendering.
 */
export async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new AdapterError(
      'This source needs a real browser, but Playwright is not installed. ' +
        'Run `npm install playwright && npx playwright install chromium`, or use ' +
        '`docker compose --profile hunter run --rm hunter ...`.',
      false,
    );
  }
}

export interface RenderResult {
  html: string;
  finalUrl: string;
}

/**
 * Chromium builds that a Playwright release can drive, in order of preference.
 *
 * Playwright pins an exact browser build, so an image whose Chromium was
 * installed by a different Playwright version fails to launch even though a
 * perfectly usable browser is sitting on disk. Rather than telling the user to
 * re-download several hundred megabytes, fall back to what is already there.
 */
const CHROMIUM_FALLBACKS = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter((p): p is string => typeof p === 'string' && p !== '');

async function launchChromium(
  chromium: import('playwright').BrowserType,
): Promise<import('playwright').Browser> {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  try {
    return await chromium.launch({ args });
  } catch (err) {
    const message = (err as Error).message;
    if (!/Executable doesn't exist|Failed to launch/i.test(message)) throw err;

    for (const executablePath of CHROMIUM_FALLBACKS) {
      if (!existsSync(executablePath)) continue;
      try {
        return await chromium.launch({ args, executablePath });
      } catch {
        // Try the next one.
      }
    }
    throw new AdapterError(
      `Could not launch Chromium: ${message.split('\n')[0]}. ` +
        'Run `npx playwright install chromium`, or set CHROMIUM_PATH to a browser you already have.',
      false,
    );
  }
}

export async function renderPage(
  url: string,
  options: { waitFor?: string; scroll?: number; onResponse?: NetworkListener } = {},
): Promise<RenderResult> {
  const { chromium } = await loadPlaywright();
  const browser = await launchChromium(chromium);
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
    const page = await context.newPage();

    if (options.onResponse) attachNetworkListener(page, options.onResponse);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout: 20_000 }).catch(() => {
        // A missing selector is reported by the extractor as "matched nothing",
        // which is a clearer message than a Playwright timeout.
      });
    }
    // Listing pages commonly load their results after first paint.
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    for (let i = 0; i < (options.scroll ?? 0); i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }

    return { html: await page.content(), finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

export type NetworkListener = (entry: {
  url: string;
  method: string;
  status: number;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  body: string;
}) => void;

function attachNetworkListener(page: import('playwright').Page, onResponse: NetworkListener): void {
  page.on('response', (response) => {
    void (async () => {
      try {
        const request = response.request();
        const type = request.resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const contentType = response.headers()['content-type'] ?? '';
        if (!contentType.includes('json')) return;
        const body = await response.text();
        // Guard against a multi-megabyte payload eating memory.
        if (body.length > 4_000_000) return;
        onResponse({
          url: response.url(),
          method: request.method(),
          status: response.status(),
          resourceType: type,
          requestHeaders: await request.allHeaders(),
          requestBody: request.postData(),
          body,
        });
      } catch {
        // Responses can be discarded mid-navigation; nothing to do about it.
      }
    })();
  });
}

export async function fetchBrowser(
  config: BrowserConfig,
  _ctx: AdapterContext,
): Promise<AdapterResult> {
  const { html, finalUrl } = await renderPage(config.url, {
    waitFor: config.wait_for,
    scroll: config.scroll,
  });
  const { items, notes } = extractFromHtml(html, config.selectors, finalUrl);
  return { items, notes };
}

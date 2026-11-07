// Trusted browser runner. Generated source reaches only an opaque-origin,
// network-blocked document; it is never evaluated in this Node process.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = process.env.EVALGEN_RENDERER_MODULES;
if (!runtime) throw new Error('Screenshot runtime is not configured.');
const requireRuntime = require('node:module').createRequire(path.join(runtime, '../package.json'));
const { chromium: playwright } = requireRuntime('playwright-core');
const { extractArtifact, previewDocument } = require(process.env.EVALGEN_ARTIFACT_MODULE || path.join(__dirname, 'web/artifacts.js'));

const WIDTH = 960;
const HEIGHT = 640;
const MAX_HEIGHT = 2000;
const MAX_PNG = 524288;
const MAX_BATCH_URLS = 2800000;
const url = 'https://evalgen-preview.invalid/';
const debug = message => { if (process.env.EVALGEN_RENDERER_DEBUG === '1') process.stderr.write(`${message}\n`); };

async function launch() {
  if (process.env.EVALGEN_CHROMIUM_EXECUTABLE) {
    return playwright.launch({ executablePath: process.env.EVALGEN_CHROMIUM_EXECUTABLE, headless: true, chromiumSandbox: true });
  }
  if (process.env.EVALGEN_RENDERER_REMOTE !== '1') throw new Error('Local Chromium is unavailable.');
  // Resolve through package exports (Chromium is an ESM package without a
  // CommonJS "main", so requiring its absolute directory does not work).
  const chromiumModule = requireRuntime('@sparticuz/chromium');
  const chromium = chromiumModule.default || chromiumModule;
  chromium.setGraphicsMode = false;
  return playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
}

async function capture(browser, source, format) {
  const artifact = extractArtifact(source, format);
  if (!artifact || artifact.format !== format) throw new Error(`No complete ${format.toUpperCase()} design was found in the response.`);
  const document = previewDocument(artifact);
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1,
    offline: true, serviceWorkers: 'block', acceptDownloads: false,
    permissions: [], colorScheme: 'light', reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    context.on('page', popup => { if (popup !== page) void popup.close(); });
    page.on('dialog', dialog => { void dialog.dismiss(); });
    let initial = true;
    await context.route('**/*', async route => {
      const request = route.request();
      if (initial && request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === url) {
        initial = false;
        return route.fulfill({
          status: 200, contentType: 'text/html; charset=utf-8', body: document,
          headers: {
            'Content-Security-Policy': format === 'html' ? 'sandbox allow-scripts' : 'sandbox',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
          },
        });
      }
      return route.abort('blockedbyclient');
    });
    debug('loading design');
    await page.goto(url, { waitUntil: 'load', timeout: 10000 });
    debug('waiting for fonts');
    await page.evaluate(() => Promise.race([
      document.fonts.ready,
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]));
    await page.waitForTimeout(250);
    debug('waiting for animation frames');
    if (format === 'html') {
      await Promise.race([
        page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
        page.waitForTimeout(100),
      ]);
    } else {
      // The SVG policy deliberately disables scripts, including scheduled JS
      // callbacks. Let Chromium paint without waiting for blocked callbacks.
      await page.waitForTimeout(32);
    }
    if (page.url() !== url) throw new Error('The design attempted to navigate away during capture.');
    const contentHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0));
    const height = Math.max(HEIGHT, Math.min(MAX_HEIGHT, contentHeight));
    debug(`taking screenshot ${height}`);
    const png = await page.screenshot({
      type: 'png', fullPage: true, clip: { x: 0, y: 0, width: WIDTH, height },
      animations: 'disabled', timeout: 10000,
    });
    if (png.length > MAX_PNG) throw new Error('The rendered screenshot exceeds the 512 KiB image limit.');
    debug('screenshot complete');
    return { data_url: `data:image/png;base64,${png.toString('base64')}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      viewport: { width: WIDTH, height: HEIGHT }, captured_at: new Date().toISOString() };
  } finally {
    await context.close();
  }
}

async function main() {
  const input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 4200000) throw new Error('Screenshot input exceeds its limit.');
  const payload = JSON.parse(input);
  if (!['svg', 'html'].includes(payload.output_format) || !Array.isArray(payload.outputs) || payload.outputs.length > 10
    || payload.outputs.some(source => typeof source !== 'string' || source.length > 100000)) throw new Error('Invalid screenshot request.');
  const results = [];
  let used = 0;
  for (const source of payload.outputs) {
    const source_hash = crypto.createHash('sha256').update(source).digest('hex');
    let browser;
    try {
      // Serverless Chromium runs in single-process mode: closing a context can
      // terminate that browser. A fresh browser per output also keeps state and
      // crashes isolated, while reusing the VM's already-decompressed binary.
      browser = await launch();
      const result = await capture(browser, source, payload.output_format);
      if (used + result.data_url.length > MAX_BATCH_URLS) throw new Error('The screenshot batch exceeds its image budget; capture fewer responses at once.');
      used += result.data_url.length;
      results.push({ ...result, source_hash });
    } catch (error) {
      // Browser/transport diagnostics may include generated source or runtime
      // paths. Keep per-output failures concise and independent.
      debug(error?.stack || error);
      const message = String(error?.message || 'Screenshot rendering failed.');
      const expected = /^(?:No complete |The design attempted |The rendered screenshot |The screenshot batch )/.test(message);
      results.push({ source_hash, error: expected ? message : 'The browser could not finish rendering this response.' });
    } finally {
      if (browser) await browser.close();
    }
  }
  process.stdout.write(JSON.stringify(results));
}

main().catch(error => { debug(error?.stack || error); process.stderr.write('Screenshot browser setup or execution failed.\n'); process.exitCode = 1; });

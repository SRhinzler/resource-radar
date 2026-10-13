// Optional online check: electron scripts/smoke-public-video.js --smoke-url=<public-url>
//   --smoke-temp=<existing-temp-parent> [--smoke-receipt=<receipt.json>]
// Uses the real main, preload, renderer and bundled helpers, never the user's Downloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const url = argument('smoke-url');
const tempParent = argument('smoke-temp');
const receiptPath = argument('smoke-receipt');
console.log('Smoke check: application entry loaded');
if (!url || !tempParent || !fs.statSync(tempParent).isDirectory()) {
  throw new Error('Supply a public video URL and an existing temporary parent directory.');
}
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(tempParent, 'resource-radar-ui-smoke-'));
// Electron treats a script entry's folder as appPath. Match a normal `electron .` launch.
app.getAppPath = () => root;
app.setPath('downloads', directory);
let window;
let finished = false;
let summary;

async function waitFor(expression, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await window.webContents.executeJavaScript(expression);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The smoke check timed out waiting for the application.');
}

async function run() {
  await window.webContents.executeJavaScript(`
    window.__smokeEvents = [];
    window.resourceRadar.onDownloadEvent(event => window.__smokeEvents.push(event));
    document.getElementById('url-input').value = ${JSON.stringify(url)};
    document.getElementById('scan-button').click();
  `);
  const scanned = await waitFor(`(() => {
    if (document.getElementById('scan-button').disabled) return null;
    return {
      video: !document.getElementById('video-results').classList.contains('hidden'),
      message: document.getElementById('global-message').textContent
    };
  })()`);
  assert.equal(scanned.video, true, `Scan did not find a video: ${scanned.message}`);
  await window.webContents.executeJavaScript("document.getElementById('download-video').click()");
  const completed = await waitFor(`(() => {
    const event = window.__smokeEvents.find(event => event.type === 'job-complete');
    return event ? {
      canceled: event.canceled,
      results: event.results.map(result => ({ok:result.ok, path:result.path, fileName:result.fileName, error:result.error}))
    } : null;
  })()`, 240_000);
  assert.equal(completed.canceled, false);
  assert.equal(completed.results.length, 1);
  const result = completed.results[0];
  assert.equal(result.ok, true, result.error);
  assert.equal(path.dirname(result.path), directory);
  assert.ok(fs.statSync(result.path).size > 0);
  assert.ok(!/\[[\w-]+\]\.[^.]+$/.test(result.fileName), 'Unexpected trailing media ID');
  assert.ok(!fs.readdirSync(directory).some((name) => name.startsWith('.resource-radar-')));
  const progress = await window.webContents.executeJavaScript(`({
    updates: window.__smokeEvents.filter(event => event.type === 'item-progress').length,
    label: document.getElementById('progress-label').textContent,
    percentage: document.getElementById('progress-percent').textContent
  })`);
  assert.ok(progress.updates > 0, 'No progress events reached the renderer');
  assert.equal(progress.label, 'Queue complete');
  assert.equal(progress.percentage, '100%');
  summary = { scan: 'video', downloaded: true, cleanFilename: true, bytes: fs.statSync(result.path).size, progressUpdates: progress.updates };
  console.log(JSON.stringify(summary));
}

async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) console.error(error.message);
  // On failure let main cancel any owned child before removing the test folder.
  app.emit('before-quit');
  await new Promise((resolve) => setTimeout(resolve, error ? 1500 : 0));
  try {
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (cleanupError) {
    error ||= cleanupError;
  }
  if (receiptPath) fs.writeFileSync(receiptPath, JSON.stringify({ ok: !error, ...summary, error: error?.message || null }, null, 2));
  app.exit(error ? 1 : 0);
}

const watchdog = setTimeout(() => finish(new Error('Smoke check exceeded five minutes.')), 300_000);
process.on('uncaughtException', (error) => finish(error));
app.once('browser-window-created', (_event, createdWindow) => {
  console.log('Smoke check: application window created');
  window = createdWindow;
  window.hide();
  window.webContents.once('did-finish-load', () => run().then(() => finish(), finish));
});
require('../src/main');

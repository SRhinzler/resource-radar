// Offline UI smoke: real local renderers; updater/network/installer and Android native calls are fixtures.
// electron scripts/smoke-v2-ui.js --smoke-temp=<existing temporary parent>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const root = path.resolve(__dirname, '..');
const parent = process.argv.find((arg) => arg.startsWith('--smoke-temp='))?.slice(13);
if (!parent || !fs.statSync(parent).isDirectory()) throw new Error('Pass an existing --smoke-temp directory.');
const directory = fs.mkdtempSync(path.join(parent, 'radar-v2-ui-'));
const dataDir = path.join(directory, 'user-data');
const downloads = path.join(directory, 'downloads');
fs.mkdirSync(dataDir);
fs.mkdirSync(downloads);
const savedFile = path.join(downloads, 'Smoke.txt');
fs.writeFileSync(savedFile, 'UI smoke fixture');
app.setPath('userData', dataDir);
app.setPath('downloads', downloads);
app.setPath('temp', directory);
app.getAppPath = () => root;
app.getVersion = () => '2.0.0';
const history = require('../src/core/history-store');
history.saveState(dataDir, {
  theme: 'light', urlHistory: [{ url: 'https://example.com/lesson' }],
  downloadHistory: [{ id: 'smoke-file', fileName: 'Smoke.txt', path: savedFile }],
});
const opened = [];
shell.openPath = async (target) => { opened.push(target); return ''; };
const updateCore = require('../src/core/update-check');
const asset = updateCore.normalizeReleaseAsset({
  state: 'uploaded', name: 'Resource-Radar-Setup-2.1.0.exe', size: 9,
  browser_download_url: 'https://github.com/SRhinzler/resource-radar/releases/download/v2.1.0/Resource-Radar-Setup-2.1.0.exe',
  digest: 'sha256:' + 'a'.repeat(64),
}, 'v2.1.0');
const notes = '<img src=x onerror="window.__unsafe=true">\n## UI fixture changelog';
const release = { tagName: 'v2.1.0', title: 'Resource Radar 2.1.0', body: notes,
  assetName: asset.name, assetSize: asset.size, hasDigest: true, asset };
let checkCount = 0;
let offered = false;
let finishDownload;
let desktop;
let finished = false;
const rendererErrors = [];
updateCore.checkLatestRelease = async () => {
  checkCount++;
  return offered ? { status: 'available', currentVersion: '2.0.0', latestVersion: '2.1.0', release }
    : { status: 'up-to-date', currentVersion: '2.0.0', latestVersion: '1.0.0' };
};
updateCore.downloadReleaseAsset = async (_asset, destination, options) => {
  await new Promise((resolve) => { finishDownload = resolve; });
  fs.writeFileSync(destination, 'installer');
  options.onProgress({ receivedBytes: 9, totalBytes: 9, percent: 100 });
  return { path: destination, digestVerified: true };
};
require('../src/core/yt-dlp').getToolStatus = async () => ({ ready: true });

async function evaluate(window, code) { return window.webContents.executeJavaScript(code); }
async function waitFor(window, code, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await evaluate(window, code);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`UI smoke timed out: ${label}`);
}
const visible = (id) => `document.getElementById(${JSON.stringify(id)}).getClientRects().length > 0`;
const click = (window, id) => evaluate(window, `document.getElementById(${JSON.stringify(id)}).click()`);
function trackErrors(window) {
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && /Uncaught|TypeError|ReferenceError/.test(message)) rendererErrors.push(message);
  });
}

async function desktopSmoke() {
  await waitFor(desktop, "document.getElementById('url-history-list').children.length === 1", 'desktop history loaded');
  assert.equal(checkCount, 1, 'one automatic startup check');
  assert.equal(await evaluate(desktop, visible('update-modal')), false, 'no startup popup for older release');
  assert.equal(await evaluate(desktop, visible('url-history-view')), false);
  assert.equal(await evaluate(desktop, "document.getElementById('app-menu').inert"), true);
  await click(desktop, 'menu-toggle');
  await click(desktop, 'menu-theme');
  await waitFor(desktop, "document.documentElement.dataset.theme === 'dark'", 'theme switch');
  await click(desktop, 'menu-url-history');
  assert.equal(await evaluate(desktop, visible('home-view')), false);
  assert.equal(await evaluate(desktop, visible('url-history-view')), true);
  await evaluate(desktop, "document.querySelector('#url-history-list button').click()");
  assert.equal(await evaluate(desktop, "document.getElementById('url-input').value"), 'https://example.com/lesson');
  assert.equal(await evaluate(desktop, visible('home-view')), true);
  await click(desktop, 'menu-toggle');
  await click(desktop, 'menu-download-history');
  await evaluate(desktop, "document.querySelector('#download-history-list button').click()");
  await waitFor(desktop, "document.getElementById('global-message').textContent.includes('Opening')", 'click file dispatch');
  assert.equal(opened[0], savedFile);
  assert.equal(await evaluate(desktop, visible('global-message')), true, 'history errors/messages outside scanner');
  await click(desktop, 'menu-toggle');
  await click(desktop, 'menu-check-updates');
  await waitFor(desktop, "document.getElementById('update-modal-title').textContent.includes('up to date')", 'manual no update');
  await click(desktop, 'update-close');
  offered = true;
  await click(desktop, 'menu-toggle');
  await click(desktop, 'menu-check-updates');
  await waitFor(desktop, "!document.getElementById('update-download').disabled", 'newer release popup');
  assert.equal(await evaluate(desktop, "document.getElementById('update-release-body').textContent"), notes);
  assert.equal(await evaluate(desktop, "document.querySelectorAll('#update-release-body img').length"), 0);
  await click(desktop, 'update-download');
  await waitFor(desktop, "document.getElementById('update-modal-title').textContent === 'Downloading update'", 'update download');
  await click(desktop, 'update-close');
  assert.equal(await evaluate(desktop, visible('update-modal')), false, 'close while downloading');
  assert.equal(await evaluate(desktop, "document.getElementById('app-content').inert"), false);
  const checksBeforeReopen = checkCount;
  await click(desktop, 'menu-toggle');
  await click(desktop, 'menu-check-updates');
  assert.equal(checkCount, checksBeforeReopen, 'reopen download without re-check');
  while (!finishDownload) await new Promise((resolve) => setTimeout(resolve, 20));
  finishDownload();
  await waitFor(desktop, "document.getElementById('update-modal-title').textContent === 'Installer opened'", 'verified installer handoff');
  assert.equal(opened.length, 2, 'one installer dispatch, stubbed');
  assert.equal(history.loadState(dataDir).state.theme, 'dark');
  await click(desktop, 'update-close');
  const loaded = new Promise((resolve) => desktop.webContents.once('did-finish-load', resolve));
  desktop.reload();
  await loaded;
  await waitFor(desktop, "document.documentElement.dataset.theme === 'dark'", 'persisted theme');
  await waitFor(desktop, visible('update-modal'), 'startup available popup');
  console.log('Windows UI: menu/pages, restore/open, theme persistence, startup/manual check, literal changelog and background install handoff passed (installer stubbed).');
}

async function androidSmoke() {
  let androidChecks = 0;
  let androidDownloads = 0;
  let openedHistory = '';
  let androidOffered = false;
  let failCheck = false;
  let status = { ok: true, state: 'idle' };
  const apkRelease = { tagName: 'v2.1', title: 'Resource Radar 2.1', body: notes,
    assetName: 'Resource-Radar-Android-2.1.apk', assetSize: 1024, hasDigest: true };
  const entries = [{ id: 'smoke-android-file', displayName: 'Smoke.txt', size: 16,
    relativePath: 'Download/', completedAt: Date.now(), available: true }];
  ipcMain.handle('smoke-android-request', (_event, operation, payload) => {
    switch (operation) {
      case 'getMediaToolStatus': return { ok: true, ready: true };
      case 'getDownloadHistory': return { ok: true, downloads: entries };
      case 'openDownload': openedHistory = payload; return { ok: true, message: 'Opening Smoke.txt' };
      case 'clearDownloadHistory': entries.length = 0; return { ok: true };
      case 'getUpdateStatus': return status;
      case 'checkForUpdates':
        androidChecks++;
        if (failCheck) return { ok: false, message: 'Offline test fixture' };
        return { ok: true, hasUpdate: androidOffered, downloadable: androidOffered, release: apkRelease, message: androidOffered ? 'Update available' : 'Up to date' };
      case 'downloadUpdate':
        androidDownloads++;
        status = { ok: true, state: 'downloading', release: apkRelease, percent: 10, downloadedBytes: 102, totalBytes: 1024 };
        return status;
      case 'openUpdateInstallSettings': return { ok: true, message: 'Settings requested (test)' };
      default: return { ok: false, message: 'Unexpected fixture call: ' + operation };
    }
  });
  const window = new BrowserWindow({ show: false, width: 412, height: 820, webPreferences: {
    preload: path.join(__dirname, 'fixtures/android-ui-preload.js'),
    contextIsolation: false, nodeIntegration: false, sandbox: false,
  } });
  trackErrors(window);
  await window.loadFile(path.join(root, 'android/app/src/main/assets/index.html'));
  await waitFor(window, "document.getElementById('menu-update-status').textContent.includes('up to date')", 'Android startup check');
  assert.equal(androidChecks, 1);
  assert.equal(await evaluate(window, visible('update-panel')), false);
  await click(window, 'menu-toggle');
  await click(window, 'theme-toggle');
  await click(window, 'menu-url-history');
  assert.equal(await evaluate(window, visible('home-view')), false);
  assert.equal(await evaluate(window, visible('url-history-view')), true);
  await evaluate(window, "localStorage.setItem('resource-radar.url-history.v1', JSON.stringify(['https://example.com/lesson']));");
  await window.loadFile(path.join(root, 'android/app/src/main/assets/index.html'));
  await waitFor(window, "document.documentElement.dataset.theme === 'dark'", 'Android theme persisted');
  await click(window, 'menu-toggle');
  await click(window, 'menu-url-history');
  await evaluate(window, "document.querySelector('#url-history-list button').click()");
  assert.equal(await evaluate(window, visible('home-view')), true);
  assert.equal(await evaluate(window, "document.getElementById('url-input').value"), 'https://example.com/lesson');
  await click(window, 'menu-toggle');
  await click(window, 'menu-download-history');
  await waitFor(window, "document.querySelector('#download-history-list button') !== null", 'Android history loaded');
  await evaluate(window, "document.querySelector('#download-history-list button').click()");
  await waitFor(window, "document.getElementById('global-message').textContent.includes('Opening')", 'Android open file');
  assert.equal(openedHistory, 'smoke-android-file');
  assert.equal(await evaluate(window, "window.resourceRadar.__handleBack()"), true);
  assert.equal(await evaluate(window, visible('home-view')), true);
  failCheck = true;
  await click(window, 'menu-toggle');
  await click(window, 'menu-check-updates');
  await waitFor(window, "document.getElementById('update-title').textContent === 'Update check unavailable'", 'Android manual offline state');
  failCheck = false;
  androidOffered = true;
  await click(window, 'update-retry');
  await waitFor(window, "!document.getElementById('update-download').classList.contains('hidden')", 'Android update offered');
  assert.equal(await evaluate(window, "document.getElementById('update-body').textContent"), notes);
  assert.equal(await evaluate(window, "document.querySelectorAll('#update-body img').length"), 0);
  await click(window, 'update-download');
  await waitFor(window, "document.getElementById('update-download').textContent === 'Downloading…'", 'Android download progress');
  await click(window, 'update-close');
  assert.equal(await evaluate(window, visible('update-panel')), false);
  failCheck = true;
  const checksBeforeReopen = androidChecks;
  await click(window, 'menu-toggle');
  await click(window, 'menu-check-updates');
  await waitFor(window, "document.getElementById('update-download').textContent === 'Downloading…'", 'Android reopen active transfer');
  assert.equal(androidChecks, checksBeforeReopen, 'Android progress reopens offline without another GitHub check');
  assert.equal(androidDownloads, 1);
  await click(window, 'update-close');
  status = { ok: true, state: 'blocked', release: apkRelease, message: 'Allow install unknown apps' };
  await evaluate(window, "window.resourceRadar.__resume()");
  await waitFor(window, visible('update-panel'), 'Android completion surfaces blocked installer after dismiss');
  await waitFor(window, visible('update-settings'), 'Android permission action');
  status = { ok: true, state: 'installer_opened', release: apkRelease, message: 'System installer opened' };
  await evaluate(window, "window.resourceRadar.__resume()");
  await waitFor(window, "document.getElementById('update-download').textContent === 'Install again'", 'Android installer handoff state');
  window.destroy();
  console.log('Android WebView UI in Chromium: menu/pages/back, theme/history persistence, updater popup/progress/permission/retry passed (native bridge stubbed, not a device installation).');
}

async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) console.error(error.stack || error.message);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  // Chromium may keep user-data files open until exit. Temp contents contain only test fixtures.
  try { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); }
  catch { console.log('Fixture profile will remain in the approved temporary directory until process exit.'); }
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(new Error('UI smoke exceeded 90 seconds')), 90000);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
app.once('browser-window-created', (_event, window) => {
  desktop = window;
  window.hide();
  trackErrors(window);
  window.webContents.once('did-finish-load', () => desktopSmoke().then(androidSmoke).then(() => {
    assert.deepEqual(rendererErrors, [], 'No renderer exceptions');
    console.log('V2 UI smoke passed; no real installer was launched and no GitHub fixture was published.');
    return finish();
  }).catch(finish));
});
require('../src/main');

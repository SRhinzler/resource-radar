const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

async function loadMain(t, overrides = {}) {
  const root = overrides.root || fs.mkdtempSync(path.join(os.tmpdir(), 'radar-main-'));
  if (!overrides.root) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const events = [];
  const opened = [];
  const mainPath = path.resolve(__dirname, '../src/main.js');
  const localRequire = createRequire(mainPath);
  class BrowserWindow {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    loadFile() {}
    static getAllWindows() { return []; }
  }
  const electron = {
    app: {
      isPackaged: false, getPath: () => root, getAppPath: () => path.dirname(path.dirname(mainPath)),
      whenReady: () => Promise.resolve(), on() {}, quit() {},
    },
    BrowserWindow,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    shell: { openPath: async (directory) => { opened.push(directory); return ''; } },
  };
  const sender = { isDestroyed: () => false, send: (_channel, event) => events.push(event) };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
    require: (name) => name === 'electron' ? electron : overrides[name] || localRequire(name),
    __dirname: path.dirname(mainPath), process, AbortController, console,
  }, { filename: mainPath });
  await new Promise(setImmediate);
  return { root, events, opened, invoke: (name, value) => handlers.get(name)({ sender }, value) };
}

test('inspect-platform routes a resolved LinkedIn short link to media extraction', async (t) => {
  const canonical = 'https://www.linkedin.com/posts/example-video-activity-1234567890123456789-abcd/';
  let extracted = '';
  const main = await loadMain(t, {
    './core/platform-input': { resolvePlatformInput: async (url) => {
      assert.equal(url, 'https://lnkd.in/p/example');
      return { url: canonical, platform: 'linkedin', playlist: false };
    } },
    './core/yt-dlp': { extractMediaInfo: async (url) => { extracted = url; return { url, title: 'Public video' }; } },
  });
  const result = await main.invoke('inspect-platform', 'https://lnkd.in/p/example');
  assert.equal(result.mode, 'video');
  assert.equal(result.media.url, canonical);
  assert.equal(extracted, canonical);
});

test('playlist IPC downloads remain sequential and oldest-first inside a derived playlist folder', async (t) => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const main = await loadMain(t, {
    './core/yt-dlp': {
      extractPlaylistInfo: async () => ({ entries: [
        { url: 'https://www.youtube.com/watch?v=new12345678', title: 'Lesson', available: true, uploadDate: '20250102' },
        { url: 'https://www.youtube.com/watch?v=bad12345678', title: 'Private', available: false },
        { url: 'https://www.youtube.com/watch?v=old12345678', title: 'Lesson', available: true, uploadDate: '20200101' },
      ] }),
      downloadMedia: async (options) => {
        calls.push(options);
        active += 1;
        maxActive = Math.max(maxActive, active);
        options.onProgress({ downloadedBytes: 1, totalBytes: 2, percent: 50 });
        await new Promise(setImmediate);
        active -= 1;
        return { fileName: `${options.order}. Lesson.mp4` };
      },
    },
  });
  const result = await main.invoke('download-platform-media', {
    url: 'https://www.youtube.com/playlist?list=PLcourse123', playlist: true,
  });
  const playlistDirectory = path.join(main.root, 'Playlist', 'Playlist - PLcourse123');
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map((call) => call.order), [1, 2]);
  assert.ok(calls[0].url.includes('old12345678'));
  assert.ok(calls.every((call) => call.downloadDirectory === playlistDirectory));
  assert.equal(result.results.length, 2);
  assert.equal(main.events[0].downloadDirectory, playlistDirectory);
  assert.equal(main.events.at(-1).downloadDirectory, playlistDirectory);
  assert.equal(main.events.filter((event) => event.type === 'item-progress').length, 2);
  await main.invoke('open-downloads', { kind: 'playlist', name: 'Playlist - PLcourse123' });
  await main.invoke('open-downloads', 'C:\\outside');
  assert.deepEqual(main.opened, [playlistDirectory, main.root]);
});

test('single video IPC still saves to the Downloads root', async (t) => {
  let directory;
  const main = await loadMain(t, {
    './core/yt-dlp': {
      extractMediaInfo: async (url) => ({ url, title: 'Single' }),
      downloadMedia: async (options) => {
        directory = options.downloadDirectory;
        assert.equal(options.order, null);
        return { fileName: 'Single.mp4' };
      },
    },
  });
  await main.invoke('download-platform-media', { url: 'https://www.instagram.com/reel/abc123/', playlist: false });
  assert.equal(directory, main.root);
});

test('direct IPC keeps three concurrent workers and separate progress identities', async (t) => {
  let active = 0;
  let maxActive = 0;
  const directories = [];
  const main = await loadMain(t, {
    './core/downloader': {
      describeDownloadError: (error) => error.message,
      downloadResource: async (_resource, options) => {
        directories.push(options.downloadDirectory);
        active += 1;
        maxActive = Math.max(maxActive, active);
        options.onProgress({ receivedBytes: 10, expectedBytes: 100, percent: 10, speedBytesPerSecond: 20, etaSeconds: 4.5 });
        await new Promise(setImmediate);
        active -= 1;
        return { fileName: 'file.pdf' };
      },
    },
  });
  const result = await main.invoke('download-resources', Array.from({ length: 5 }, () => ({
    url: 'https://example.com/file.pdf', kind: 'document',
  })));
  assert.equal(maxActive, 3);
  assert.equal(result.results.length, 5);
  assert.equal(new Set(result.results.map((entry) => entry.itemId)).size, 5);
  assert.ok(directories.every((directory) => directory === main.root));
  const progress = main.events.filter((event) => event.type === 'item-progress');
  assert.equal(progress.length, 5);
  assert.ok(progress.every((event) => event.speedBytesPerSecond === 20 && event.etaSeconds === 4.5));
});

test('theme, URL history, and download history persist through narrow IPC operations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-persistent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = await loadMain(t, { root });
  assert.equal((await first.invoke('get-preferences')).theme, 'light');
  await first.invoke('set-theme', 'dark');
  const remembered = await first.invoke('remember-url', 'example.com/library');
  assert.equal(remembered.entries[0].url, 'https://example.com/library');
  assert.throws(() => first.invoke('set-theme', 'sepia'), /light or dark/);

  const second = await loadMain(t, {
    root,
    './core/downloader': {
      describeDownloadError: (error) => error.message,
      downloadResource: async (_resource, options) => {
        const filePath = path.join(options.downloadDirectory, 'Report.pdf');
        fs.writeFileSync(filePath, 'saved');
        return { fileName: 'Report.pdf', path: filePath };
      },
    },
  });
  assert.equal((await second.invoke('get-preferences')).theme, 'dark');
  assert.equal((await second.invoke('get-url-history')).entries[0].url, 'https://example.com/library');

  await second.invoke('download-resources', [{ url: 'https://example.com/report.pdf', kind: 'document' }]);
  const history = await second.invoke('get-download-history');
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].fileName, 'Report.pdf');
  assert.equal(history.entries[0].available, true);
  assert.equal(Object.hasOwn(history.entries[0], 'path'), false);

  await second.invoke('open-download-file', history.entries[0].id);
  assert.deepEqual(second.opened, [path.join(root, 'Report.pdf')]);
  await second.invoke('clear-url-history');
  assert.deepEqual((await second.invoke('get-url-history')).entries, []);
  await second.invoke('clear-download-history');
  assert.deepEqual((await second.invoke('get-download-history')).entries, []);
});

test('update IPC caches a checked release, ignores renderer arguments, and prevents duplicate downloads', async (t) => {
  let releaseDownload;
  let digestVerified = true;
  const downloadGate = new Promise((resolve) => { releaseDownload = resolve; });
  const main = await loadMain(t, {
    './core/update-check': {
      normalizeReleaseAsset: require('../src/core/update-check').normalizeReleaseAsset,
      checkLatestRelease: async (version) => {
        assert.equal(version, '2.0.0');
        return {
          status: 'available',
          currentVersion: '2.0.0',
          latestVersion: '2.1.0',
          release: {
            tagName: 'v2.1.0',
            title: 'Resource Radar update',
            body: '<b>Notes</b>',
            publishedAt: '2026-10-01T00:00:00Z',
            assetName: 'Resource-Radar-Setup-2.1.0.exe',
            assetSize: 9,
            hasDigest: true,
            asset: {
              name: 'Resource-Radar-Setup-2.1.0.exe',
              state: 'uploaded',
              size: 9,
              contentType: 'application/octet-stream',
              url: 'https://github.com/SRhinzler/resource-radar/releases/download/v2.1.0/Resource-Radar-Setup-2.1.0.exe',
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
        };
      },
      downloadReleaseAsset: async (asset, destination, options) => {
        assert.equal(asset.name, 'Resource-Radar-Setup-2.1.0.exe');
        assert.match(destination, /resource-radar-update-/);
        await downloadGate;
        fs.writeFileSync(destination, 'installer');
        options.onProgress({ receivedBytes: 9, totalBytes: 9, percent: 100 });
        return { path: destination, digestVerified };
      },
    },
  });

  const checked = await main.invoke('check-for-updates');
  assert.equal(checked.status, 'available');
  assert.equal(checked.release.tagName, 'v2.1.0');
  assert.equal(Object.hasOwn(checked.release, 'asset'), false);

  const first = main.invoke('download-update', { url: 'https://evil.example/installer.exe', path: 'C:\\outside.exe' });
  await new Promise(setImmediate);
  const duplicate = await main.invoke('download-update', { url: 'https://another.example/installer.exe' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'An update download is already in progress.');
  const duringDownload = await main.invoke('check-for-updates');
  assert.equal(duringDownload.status, 'downloading');
  assert.equal(duringDownload.release.tagName, 'v2.1.0');
  releaseDownload();
  const downloaded = await first;
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.tagName, 'v2.1.0');
  assert.equal(downloaded.assetName, 'Resource-Radar-Setup-2.1.0.exe');
  assert.equal(downloaded.digestVerified, true);
  assert.equal(main.opened.length, 1);
  assert.match(main.opened[0], /resource-radar-update-/);
  assert.ok(main.events.some((event) => event.type === 'update-download-progress' && event.percent === 100));

  digestVerified = false;
  await main.invoke('check-for-updates');
  const rejected = await main.invoke('download-update');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /SHA-256 verification/);
  assert.equal(main.opened.length, 1);
});

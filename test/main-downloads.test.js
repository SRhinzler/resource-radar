const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

async function loadMain(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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

test('playlist IPC downloads remain sequential and oldest-first inside Downloads/Playlist', async (t) => {
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
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map((call) => call.order), [1, 2]);
  assert.ok(calls[0].url.includes('old12345678'));
  assert.ok(calls.every((call) => call.downloadDirectory === path.join(main.root, 'Playlist')));
  assert.equal(result.results.length, 2);
  assert.equal(main.events[0].downloadDirectory, path.join(main.root, 'Playlist'));
  assert.equal(main.events.at(-1).downloadDirectory, path.join(main.root, 'Playlist'));
  assert.equal(main.events.filter((event) => event.type === 'item-progress').length, 2);
  await main.invoke('open-downloads', 'playlist');
  await main.invoke('open-downloads', 'C:\\outside');
  assert.deepEqual(main.opened, [path.join(main.root, 'Playlist'), main.root]);
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

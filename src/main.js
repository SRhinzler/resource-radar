const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { discoverResources } = require('./core/html-discovery');
const { downloadResource, describeDownloadError } = require('./core/downloader');
const { fetchPageHtml, probeResource } = require('./core/network');
const { normalizeInput, parseHttpUrl } = require('./core/url-policy');
const { normalizePlatformUrl } = require('./core/site-policy');
const { resolvePlatformInput } = require('./core/platform-input');
const { addSequentialOrder, sortOldestFirst } = require('./core/playlist-order');
const { derivePlaylistFolderName } = require('./core/playlist-folder');
const {
  checkLatestRelease,
  downloadReleaseAsset,
  normalizeReleaseAsset,
} = require('./core/update-check');
const {
  addDownloadHistory,
  clearDownloadHistory,
  clearUrlHistory,
  emptyState,
  loadState,
  rememberUrl,
  saveState,
} = require('./core/history-store');
const { safeFileName } = require('./core/safe-file');
const {
  downloadMedia,
  extractMediaInfo,
  extractPlaylistInfo,
  getToolStatus,
} = require('./core/yt-dlp');

const MAX_CANDIDATES = 80;
const MAX_SELECTED_DOWNLOADS = 40;
const MAX_PLAYLIST_ENTRIES = 100;
const MAX_PARALLEL_DIRECT_DOWNLOADS = 3;
const PLAYLIST_PARENT_FOLDER = 'Playlist';
const activeJobs = new Map();
let persistentState = emptyState();
let persistenceError = '';
let latestUpdate = null;
let updateCheckPromise = null;
let updateDownloadPromise = null;
let activeUpdateRelease = null;
let lastUpdateDownloadEvent = null;
let updateDownloadController = null;

function initializePersistentState() {
  const loaded = loadState(app.getPath('userData'));
  persistentState = loaded.state;
  persistenceError = loaded.error || '';
}

function persistState() {
  try {
    saveState(app.getPath('userData'), persistentState);
    persistenceError = '';
  } catch {
    persistenceError = 'History could not be saved on this PC.';
  }
}

function isInsideDirectory(candidate, directory) {
  const root = path.resolve(directory);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function isSafeDownloadPath(candidate) {
  return isInsideDirectory(candidate, app.getPath('downloads'));
}

function isAvailableDownloadPath(candidate) {
  if (!isSafeDownloadPath(candidate)) return false;

  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return false;
    const root = fs.realpathSync(app.getPath('downloads'));
    const target = fs.realpathSync(candidate);
    return isInsideDirectory(target, root);
  } catch {
    return false;
  }
}

function downloadHistoryForRenderer() {
  return persistentState.downloadHistory.map((entry) => ({
    id: entry.id,
    fileName: entry.fileName,
    title: entry.title,
    url: entry.url,
    mode: entry.mode,
    order: entry.order,
    completedAt: entry.completedAt,
    available: isAvailableDownloadPath(entry.path),
  }));
}

function recordCompletedDownload({ result, url, title, mode, order = null }) {
  const candidate = result?.path ? path.resolve(String(result.path)) : '';
  if (!candidate || !isSafeDownloadPath(candidate)) return;

  persistentState = addDownloadHistory(persistentState, {
    id: crypto.randomUUID(),
    fileName: result.fileName || path.basename(candidate),
    title: title || result.fileName || path.basename(candidate),
    path: candidate,
    url: url || result.url || '',
    mode,
    order,
    completedAt: new Date().toISOString(),
  });
  persistState();
}

function playlistFolderName(playlist, fallbackUrl) {
  return derivePlaylistFolderName({
    title: playlist?.title,
    id: playlist?.id,
    url: playlist?.url || fallbackUrl,
  });
}

function playlistDownloadDirectory(playlist, fallbackUrl) {
  return path.join(app.getPath('downloads'), PLAYLIST_PARENT_FOLDER, playlistFolderName(playlist, fallbackUrl));
}

function mediaToolOptions() {
  return {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    helperDirectory: app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(app.getAppPath(), 'bin'),
  };
}

function emitDownloadEvent(sender, event) {
  if (!sender.isDestroyed()) sender.send('download-event', event);
}

function emitUpdateEvent(sender, event) {
  lastUpdateDownloadEvent = event;
  if (sender && !sender.isDestroyed()) sender.send('update-event', event);
}

function desktopVersion() {
  if (typeof app.getVersion === 'function') return app.getVersion();
  try {
    return require('../package.json').version;
  } catch {
    return '2.0.0';
  }
}

function publicUpdateResult(result) {
  const output = {
    status: result?.status || 'error',
    currentVersion: result?.currentVersion || desktopVersion(),
    latestVersion: result?.latestVersion || '',
  };
  if (result?.error) output.error = String(result.error).slice(0, 500);
  if (result?.release) {
    output.release = {
      tagName: result.release.tagName,
      title: result.release.title,
      body: result.release.body,
      publishedAt: result.release.publishedAt,
      assetName: result.release.assetName,
      assetSize: result.release.assetSize,
      hasDigest: result.release.hasDigest,
    };
  }
  return output;
}

async function checkForUpdates() {
  if (updateDownloadPromise) {
    return {
      ...publicUpdateResult({ status: 'downloading', release: activeUpdateRelease }),
      download: lastUpdateDownloadEvent,
    };
  }
  if (updateCheckPromise) return updateCheckPromise;

  const pending = Promise.resolve().then(async () => {
    try {
      const result = await checkLatestRelease(desktopVersion());
      latestUpdate = result?.status === 'available' ? result.release : null;
      return publicUpdateResult(result);
    } catch (error) {
      latestUpdate = null;
      return {
        status: 'error',
        currentVersion: desktopVersion(),
        error: String(error?.message || 'The update check could not be completed.').slice(0, 500),
      };
    }
  });
  updateCheckPromise = pending;
  try {
    return await pending;
  } finally {
    updateCheckPromise = null;
  }
}

function installerFileName(value) {
  const name = String(value || '');
  if (!name || name !== path.basename(name) || !/\.exe$/i.test(name) || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new Error('The Windows installer name is invalid.');
  }
  return name;
}

async function isSafeTemporaryInstaller(candidate, directory, directoryStat, expectedSize) {
  const root = path.resolve(directory);
  const target = path.resolve(candidate);
  if (path.dirname(target) !== root) return false;
  try {
    const [stat, rootStat, realRoot, realFile] = await Promise.all([
      fs.promises.lstat(target),
      fs.promises.lstat(root),
      fs.promises.realpath(root),
      fs.promises.realpath(target),
    ]);
    return rootStat.isDirectory() && !rootStat.isSymbolicLink()
      && rootStat.dev === directoryStat.dev && rootStat.ino === directoryStat.ino
      && path.relative(root, realRoot) === '' && path.relative(target, realFile) === ''
      && stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size === expectedSize;
  } catch {
    return false;
  }
}

async function downloadUpdate(sender) {
  if (updateDownloadPromise) return { ok: false, error: 'An update download is already in progress.' };
  if (updateCheckPromise) return { ok: false, error: 'Wait for the update check to finish before downloading.' };
  if (!latestUpdate?.asset) return { ok: false, error: 'Check for updates again before downloading.' };

  const release = latestUpdate;
  activeUpdateRelease = release;
  lastUpdateDownloadEvent = null;
  updateDownloadController = new AbortController();
  const controller = updateDownloadController;

  // Acquire the gate before any async temp-directory or network work can start.
  const pending = Promise.resolve().then(async () => {
    let tempRoot;
    try {
      const asset = normalizeReleaseAsset(release.asset, release.tagName);
      const fileName = installerFileName(asset.name);
      emitUpdateEvent(sender, {
        type: 'update-download-started',
        tagName: release.tagName,
        assetName: fileName,
        totalBytes: asset.size,
      });
      const systemTemp = await fs.promises.realpath(app.getPath('temp'));
      tempRoot = await fs.promises.mkdtemp(path.join(systemTemp, 'resource-radar-update-'));
      const directoryStat = await fs.promises.lstat(tempRoot);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error('The update temporary directory is invalid.');
      }
      const destination = path.join(tempRoot, fileName);
      const result = await downloadReleaseAsset(asset, destination, {
        signal: controller.signal,
        onProgress: (progress) => emitUpdateEvent(sender, {
          type: 'update-download-progress',
          tagName: release.tagName,
          assetName: fileName,
          ...progress,
        }),
      });
      if (asset.digest && !result?.digestVerified) {
        throw new Error('The downloaded installer did not pass its GitHub SHA-256 verification.');
      }
      const downloadedPath = path.resolve(result?.path || '');
      if (downloadedPath !== path.resolve(destination)
        || !await isSafeTemporaryInstaller(downloadedPath, tempRoot, directoryStat, asset.size)) {
        throw new Error('The downloaded installer path could not be verified.');
      }
      if (controller.signal.aborted) throw new Error('The update download was canceled.');

      const launchError = await shell.openPath(downloadedPath);
      if (launchError) throw new Error(`The installer was downloaded but could not be opened: ${launchError}`);

      latestUpdate = null;
      const completed = {
        ok: true,
        tagName: release.tagName,
        assetName: fileName,
        digestVerified: Boolean(asset.digest && result?.digestVerified),
      };
      emitUpdateEvent(sender, {
        type: 'update-download-complete',
        ...completed,
      });
      return completed;
    } catch (error) {
      // The downloader removes only its own file. Here remove only an empty
      // directory we created, never a possibly pre-existing or replaced file.
      if (tempRoot) await fs.promises.rmdir(tempRoot).catch(() => {});
      const message = String(error?.message || 'The update download failed.').slice(0, 500);
      emitUpdateEvent(sender, { type: 'update-download-complete', ok: false, error: message });
      return { ok: false, error: message };
    }
  });
  updateDownloadPromise = pending;
  try {
    return await pending;
  } finally {
    updateDownloadPromise = null;
    activeUpdateRelease = null;
    updateDownloadController = null;
  }
}

function formatCandidate(candidate, inspection) {
  return {
    id: crypto.createHash('sha256').update(candidate.url).digest('hex').slice(0, 16),
    url: inspection?.finalUrl || candidate.url,
    originalUrl: candidate.url,
    kind: inspection?.kind || candidate.kind,
    source: candidate.source,
    label: candidate.label,
    contentType: inspection?.contentType || '',
    contentLength: inspection?.contentLength ?? null,
    statusCode: inspection?.statusCode ?? null,
    verified: Boolean(inspection?.supported),
    error: inspection?.error || '',
  };
}

async function inspectCandidates(candidates) {
  const results = [];
  let cursor = 0;
  const workerCount = Math.min(4, candidates.length);

  async function worker() {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor];
      cursor += 1;

      try {
        const inspection = await probeResource(candidate.url, { fallbackKind: candidate.kind });
        if (inspection.supported || candidate.kind !== 'unknown') {
          results.push(formatCandidate(candidate, inspection));
        }
      } catch (error) {
        if (candidate.kind !== 'unknown') {
          results.push(formatCandidate(candidate, { error: error.message }));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'video' ? -1 : 1;
    return left.url.localeCompare(right.url);
  });
}

function validateResourceList(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Select at least one resource to download.');
  }
  if (value.length > MAX_SELECTED_DOWNLOADS) {
    throw new Error(`Select no more than ${MAX_SELECTED_DOWNLOADS} resources at a time.`);
  }

  return value.map((resource) => {
    const url = parseHttpUrl(resource?.url).href;
    const kind = resource?.kind === 'video' || resource?.kind === 'document' ? resource.kind : 'unknown';
    return { url, kind };
  });
}

async function scanPage(rawUrl) {
  const normalizedUrl = normalizeInput(rawUrl);
  const page = await fetchPageHtml(normalizedUrl);
  const candidates = discoverResources(page.body, page.finalUrl).slice(0, MAX_CANDIDATES);
  const resources = await inspectCandidates(candidates);

  return {
    pageUrl: page.finalUrl,
    resources,
    downloadsDirectory: app.getPath('downloads'),
  };
}

function collectResolutionOptions(entries) {
  return [...new Set(entries.flatMap((entry) => entry.resolutions || []))]
    .filter((height) => Number.isFinite(Number(height)))
    .map(Number)
    .sort((left, right) => right - left);
}

function preparePlaylist(playlist) {
  const sorted = sortOldestFirst(playlist.entries || []);
  const available = addSequentialOrder(sorted.filter((entry) => entry.available));
  const orderByUrl = new Map(available.map((entry) => [entry.url, entry.order]));
  const entries = sorted.map((entry) => ({
    ...entry,
    order: orderByUrl.get(entry.url) || null,
  }));

  return {
    ...playlist,
    entries,
    availableCount: available.length,
    unavailableCount: entries.length - available.length,
    resolutions: collectResolutionOptions(available),
    order: 'oldest-first',
  };
}

async function inspectPlatform(rawUrl, sender) {
  const input = await resolvePlatformInput(rawUrl);
  if (!input.platform) return { mode: 'direct', url: input.url };

  if (input.playlist) {
    const playlist = await extractPlaylistInfo(input.url, {
      ...mediaToolOptions(),
      onPlaylistProgress: (progress) => emitDownloadEvent(sender, { type: 'playlist-scan-progress', ...progress }),
    });
    const prepared = preparePlaylist({ ...playlist, url: playlist.url || input.url });
    return {
      mode: 'playlist',
      ...prepared,
      playlistFolderName: playlistFolderName(prepared, input.url),
    };
  }

  return { mode: 'video', media: await extractMediaInfo(input.url, mediaToolOptions()) };
}

function createMediaJob(sender) {
  const jobId = crypto.randomUUID();
  const record = {
    sender,
    canceled: false,
    cancel: () => {},
  };
  activeJobs.set(jobId, record);
  return { jobId, record };
}

function setMediaProcess(record, processHandle) {
  record.cancel = () => processHandle.cancel();
  if (record.canceled) processHandle.cancel();
}

function jobSignal(record) {
  return {
    get aborted() {
      return record.canceled;
    },
    addEventListener() {},
  };
}

function assertMediaRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('A video URL is required.');
  const normalized = normalizePlatformUrl(request.url, { allowPlaylist: Boolean(request.playlist) });
  const maxHeight = request.maxHeight === null || request.maxHeight === undefined || request.maxHeight === ''
    ? null
    : Number(request.maxHeight);
  if (maxHeight !== null && (!Number.isFinite(maxHeight) || maxHeight < 1 || maxHeight > 10_000)) {
    throw new Error('Choose a valid resolution.');
  }
  return { ...request, url: normalized.url.href, platform: normalized.platform, playlist: normalized.playlist, maxHeight };
}

async function downloadPlatformMedia(sender, request) {
  if (!request || typeof request !== 'object') throw new Error('A video URL is required.');
  const resolved = await resolvePlatformInput(request.url);
  const input = assertMediaRequest({ ...request, url: resolved.url });
  if (input.playlist && input.platform !== 'youtube') {
    throw new Error('Only YouTube playlists can be downloaded as a queue.');
  }

  const { jobId, record } = createMediaJob(sender);
  const downloadsRoot = app.getPath('downloads');
  let downloadDirectory = input.playlist
    ? playlistDownloadDirectory(null, input.url)
    : downloadsRoot;
  let currentPlaylistFolderName = input.playlist ? path.basename(downloadDirectory) : '';
  const results = [];
  let items = [];

  emitDownloadEvent(sender, {
    type: 'job-started',
    jobId,
    total: input.playlist ? 0 : 1,
    mode: input.playlist ? 'playlist' : 'video',
    downloadDirectory,
    playlistFolderName: currentPlaylistFolderName,
  });

  try {
    if (input.playlist) {
      const playlist = preparePlaylist({
        ...(await extractPlaylistInfo(input.url, {
          ...mediaToolOptions(),
          signal: jobSignal(record),
          maxEntries: MAX_PLAYLIST_ENTRIES,
          onProcess: setMediaProcess.bind(null, record),
          onPlaylistProgress: (progress) => emitDownloadEvent(sender, {
            type: 'playlist-scan-progress',
            jobId,
            ...progress,
          }),
        })),
        url: input.url,
      });
      currentPlaylistFolderName = playlistFolderName(playlist, input.url);
      downloadDirectory = playlistDownloadDirectory(playlist, input.url);
      items = playlist.entries.filter((entry) => entry.available);
      if (!items.length) throw new Error('No available videos were found in this playlist.');
      if (items.length > MAX_PLAYLIST_ENTRIES) {
        throw new Error(`This playlist has ${items.length} available videos. Resource Radar currently supports up to ${MAX_PLAYLIST_ENTRIES} per queue.`);
      }
      emitDownloadEvent(sender, {
        type: 'playlist-ready',
        jobId,
        total: items.length,
        title: playlist.title,
        downloadDirectory,
        playlistFolderName: currentPlaylistFolderName,
      });
    } else {
      const media = await extractMediaInfo(input.url, {
        ...mediaToolOptions(),
        signal: jobSignal(record),
        onProcess: setMediaProcess.bind(null, record),
      });
      items = [{ ...media, order: null, available: true }];
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const itemId = `${index}-${crypto.createHash('sha256').update(item.url).digest('hex').slice(0, 16)}`;
      emitDownloadEvent(sender, {
        type: 'item-started',
        jobId,
        itemId,
        index,
        total: items.length,
        title: item.title,
        order: input.playlist ? item.order : null,
      });

      try {
        const result = await downloadMedia({
          url: item.url,
          downloadDirectory,
          maxHeight: input.maxHeight,
          order: input.playlist ? item.order : null,
          signal: jobSignal(record),
          options: mediaToolOptions(),
          onProcess: (handle) => setMediaProcess(record, handle),
          onProgress: (progress) => emitDownloadEvent(sender, {
            type: 'item-progress',
            jobId,
            itemId,
            index,
            ...progress,
          }),
        });
        const completed = {
          itemId,
          url: item.url,
          title: item.title,
          ok: true,
          order: input.playlist ? item.order : null,
          ...result,
        };
        results.push(completed);
        recordCompletedDownload({
          result,
          url: item.url,
          title: item.title,
          mode: input.playlist ? 'playlist' : 'video',
          order: input.playlist ? item.order : null,
        });
        emitDownloadEvent(sender, { type: 'item-complete', jobId, index, ...completed });
      } catch (error) {
        const canceled = record.canceled || error?.code === 'ABORT_ERR';
        const failed = {
          itemId,
          url: item.url,
          title: item.title,
          ok: false,
          canceled,
          order: input.playlist ? item.order : null,
          error: error?.message || 'The video download failed.',
        };
        results.push(failed);
        emitDownloadEvent(sender, { type: 'item-failed', jobId, index, ...failed });
        if (canceled) break;
      }
    }
  } finally {
    activeJobs.delete(jobId);
    emitDownloadEvent(sender, {
      type: 'job-complete',
      jobId,
      mode: input.playlist ? 'playlist' : 'video',
      downloadDirectory,
      canceled: record.canceled,
      results,
    });
  }

  return { jobId, results, canceled: record.canceled };
}

async function downloadSelected(sender, rawResources) {
  const resources = validateResourceList(rawResources);
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  const downloadDirectory = app.getPath('downloads');
  activeJobs.set(jobId, {
    sender,
    canceled: false,
    cancel: () => controller.abort(),
  });
  const results = [];

  emitDownloadEvent(sender, {
    type: 'job-started',
    jobId,
    total: resources.length,
    downloadDirectory,
  });

  let nextIndex = 0;
  async function worker() {
    while (!controller.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= resources.length) return;

      const resource = resources[index];
      const itemId = `${index}-${crypto.createHash('sha256').update(resource.url).digest('hex').slice(0, 16)}`;
      emitDownloadEvent(sender, { type: 'item-started', jobId, itemId, index, total: resources.length, url: resource.url });

      try {
        const result = await downloadResource(resource, {
          downloadDirectory,
          signal: controller.signal,
          onProgress: (progress) => emitDownloadEvent(sender, {
            type: 'item-progress',
            jobId,
            itemId,
            index,
            ...progress,
          }),
        });
        const completed = { itemId, index, url: resource.url, ok: true, ...result };
        results.push(completed);
        recordCompletedDownload({
          result,
          url: resource.url,
          title: result.fileName || resource.url,
          mode: 'direct',
        });
        emitDownloadEvent(sender, { type: 'item-complete', jobId, index, ...completed });
      } catch (error) {
        const canceled = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
        const failed = {
          itemId,
          index,
          url: resource.url,
          ok: false,
          canceled,
          error: describeDownloadError(error),
        };
        results.push(failed);
        emitDownloadEvent(sender, { type: 'item-failed', jobId, index, ...failed });
        if (canceled) controller.abort();
      }
    }
  }

  try {
    const workerCount = Math.min(MAX_PARALLEL_DIRECT_DOWNLOADS, resources.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    activeJobs.delete(jobId);
    results.sort((left, right) => left.index - right.index);
    emitDownloadEvent(sender, {
      type: 'job-complete',
      jobId,
      canceled: controller.signal.aborted,
      results,
    });
  }

  return { jobId, results, canceled: controller.signal.aborted };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 680,
    backgroundColor: '#f7f8fc',
    title: 'Resource Radar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function resolveOpenDownloadsDirectory(destination) {
  const root = path.resolve(app.getPath('downloads'));
  if (destination === 'playlist') {
    // Keep accepting the v1 fixed destination for existing renderer builds.
    return path.join(root, PLAYLIST_PARENT_FOLDER);
  }

  if (destination && typeof destination === 'object' && destination.kind === 'playlist') {
    const folderName = String(destination.name || destination.folderName || '');
    if (!folderName || folderName !== safeFileName(folderName, '') || folderName === '.' || folderName === '..') {
      throw new Error('The download folder is invalid.');
    }
    const playlistRoot = path.join(root, PLAYLIST_PARENT_FOLDER);
    const candidate = path.resolve(playlistRoot, folderName);
    if (path.dirname(candidate) !== path.resolve(playlistRoot)) throw new Error('The download folder is outside Downloads/Playlist.');
    return candidate;
  }

  return root;
}

function registerHandlers() {
  ipcMain.handle('scan-page', (_event, rawUrl) => scanPage(rawUrl));
  ipcMain.handle('download-resources', (event, resources) => downloadSelected(event.sender, resources));
  ipcMain.handle('inspect-platform', (event, rawUrl) => inspectPlatform(rawUrl, event.sender));
  ipcMain.handle('get-media-tool-status', () => getToolStatus(mediaToolOptions()));
  ipcMain.handle('download-platform-media', (event, request) => downloadPlatformMedia(event.sender, request));
  ipcMain.handle('check-for-updates', () => checkForUpdates());
  ipcMain.handle('download-update', (event) => downloadUpdate(event.sender));
  ipcMain.handle('get-preferences', () => ({ theme: persistentState.theme, error: persistenceError }));
  ipcMain.handle('set-theme', (_event, theme) => {
    if (theme !== 'light' && theme !== 'dark') throw new Error('Choose either light or dark mode.');
    persistentState = { ...persistentState, theme };
    persistState();
    return { theme: persistentState.theme, error: persistenceError };
  });
  ipcMain.handle('get-url-history', () => ({ entries: persistentState.urlHistory, error: persistenceError }));
  ipcMain.handle('remember-url', (_event, rawUrl) => {
    persistentState = rememberUrl(persistentState, rawUrl);
    persistState();
    return { entries: persistentState.urlHistory, error: persistenceError };
  });
  ipcMain.handle('clear-url-history', () => {
    persistentState = clearUrlHistory(persistentState);
    persistState();
    return { entries: persistentState.urlHistory, error: persistenceError };
  });
  ipcMain.handle('get-download-history', () => ({ entries: downloadHistoryForRenderer(), error: persistenceError }));
  ipcMain.handle('clear-download-history', () => {
    persistentState = clearDownloadHistory(persistentState);
    persistState();
    return { entries: [], error: persistenceError };
  });
  ipcMain.handle('open-download-file', async (_event, id) => {
    const entry = persistentState.downloadHistory.find((item) => item.id === String(id));
    if (!entry) return { ok: false, error: 'That download is no longer in history.' };
    if (!isAvailableDownloadPath(entry.path)) {
      return { ok: false, error: 'That downloaded file is no longer available.' };
    }

    let target = entry.path;
    try {
      target = fs.realpathSync(entry.path);
    } catch {
      return { ok: false, error: 'That downloaded file is no longer available.' };
    }
    const error = await shell.openPath(target);
    return { ok: !error, error: error || '' };
  });
  ipcMain.handle('cancel-downloads', (event, jobId) => {
    const job = activeJobs.get(String(jobId));
    if (!job || job.sender !== event.sender) return { canceled: false };
    job.canceled = true;
    job.cancel();
    return { canceled: true };
  });
  ipcMain.handle('open-downloads', async (_event, destination) => {
    try {
      const directory = resolveOpenDownloadsDirectory(destination);
      const error = await shell.openPath(directory);
      return { ok: !error, error: error || '' };
    } catch (error) {
      return { ok: false, error: error.message || 'The download folder could not be opened.' };
    }
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  initializePersistentState();
  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  updateDownloadController?.abort();
  for (const job of activeJobs.values()) {
    job.canceled = true;
    job.cancel();
  }
});

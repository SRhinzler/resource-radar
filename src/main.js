const crypto = require('node:crypto');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { discoverResources } = require('./core/html-discovery');
const { downloadResource, describeDownloadError } = require('./core/downloader');
const { fetchPageHtml, probeResource } = require('./core/network');
const { normalizeInput, parseHttpUrl } = require('./core/url-policy');
const { normalizePlatformUrl } = require('./core/site-policy');
const { resolvePlatformInput } = require('./core/platform-input');
const { addSequentialOrder, sortOldestFirst } = require('./core/playlist-order');
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
const activeJobs = new Map();

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
    return { mode: 'playlist', ...preparePlaylist(playlist) };
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
  const downloadDirectory = input.playlist
    ? path.join(app.getPath('downloads'), 'Playlist')
    : app.getPath('downloads');
  const results = [];
  let items = [];

  emitDownloadEvent(sender, {
    type: 'job-started',
    jobId,
    total: input.playlist ? 0 : 1,
    mode: input.playlist ? 'playlist' : 'video',
    downloadDirectory,
  });

  try {
    if (input.playlist) {
      const playlist = preparePlaylist(await extractPlaylistInfo(input.url, {
        ...mediaToolOptions(),
        signal: jobSignal(record),
        maxEntries: MAX_PLAYLIST_ENTRIES,
        onProcess: setMediaProcess.bind(null, record),
        onPlaylistProgress: (progress) => emitDownloadEvent(sender, {
          type: 'playlist-scan-progress',
          jobId,
          ...progress,
        }),
      }));
      items = playlist.entries.filter((entry) => entry.available);
      if (!items.length) throw new Error('No available videos were found in this playlist.');
      if (items.length > MAX_PLAYLIST_ENTRIES) {
        throw new Error(`This playlist has ${items.length} available videos. Resource Radar currently supports up to ${MAX_PLAYLIST_ENTRIES} per queue.`);
      }
      emitDownloadEvent(sender, { type: 'playlist-ready', jobId, total: items.length, title: playlist.title });
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

function registerHandlers() {
  ipcMain.handle('scan-page', (_event, rawUrl) => scanPage(rawUrl));
  ipcMain.handle('download-resources', (event, resources) => downloadSelected(event.sender, resources));
  ipcMain.handle('inspect-platform', (event, rawUrl) => inspectPlatform(rawUrl, event.sender));
  ipcMain.handle('get-media-tool-status', () => getToolStatus(mediaToolOptions()));
  ipcMain.handle('download-platform-media', (event, request) => downloadPlatformMedia(event.sender, request));
  ipcMain.handle('cancel-downloads', (event, jobId) => {
    const job = activeJobs.get(String(jobId));
    if (!job || job.sender !== event.sender) return { canceled: false };
    job.canceled = true;
    job.cancel();
    return { canceled: true };
  });
  ipcMain.handle('open-downloads', async (_event, destination) => {
    // Accept a fixed destination kind, never an arbitrary renderer-supplied path.
    const directory = destination === 'playlist'
      ? path.join(app.getPath('downloads'), 'Playlist')
      : app.getPath('downloads');
    const error = await shell.openPath(directory);
    return { ok: !error, error: error || '' };
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
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
  for (const job of activeJobs.values()) {
    job.canceled = true;
    job.cancel();
  }
});

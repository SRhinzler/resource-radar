const fs = require('node:fs');
const path = require('node:path');
const { parseHttpUrl } = require('./url-policy');

const STATE_FILE_NAME = 'resource-radar-state.json';
const MAX_URL_HISTORY = 30;
const MAX_DOWNLOAD_HISTORY = 100;

function emptyState() {
  return {
    theme: 'light',
    urlHistory: [],
    downloadHistory: [],
  };
}

function normalizeTheme(value) {
  return value === 'dark' ? 'dark' : 'light';
}

function normalizeTimestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeUrlEntry(value) {
  const rawUrl = typeof value === 'string' ? value : value?.url;
  if (!rawUrl) return null;

  try {
    const url = parseHttpUrl(rawUrl).href;
    return {
      url,
      visitedAt: normalizeTimestamp(typeof value === 'object' ? value.visitedAt : ''),
    };
  } catch {
    return null;
  }
}

function normalizeDownloadEntry(value) {
  if (!value || typeof value !== 'object' || !value.id || !value.path) return null;

  const pathValue = String(value.path).slice(0, 2048);
  const fileName = String(value.fileName || path.basename(pathValue)).slice(0, 240);
  if (!pathValue || !fileName) return null;

  return {
    id: String(value.id).slice(0, 120),
    fileName,
    title: String(value.title || fileName).slice(0, 300),
    path: pathValue,
    url: String(value.url || '').slice(0, 2048),
    mode: ['direct', 'video', 'playlist'].includes(value.mode) ? value.mode : 'direct',
    order: Number.isInteger(value.order) && value.order > 0 ? value.order : null,
    completedAt: normalizeTimestamp(value.completedAt),
  };
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const state = emptyState();
  state.theme = normalizeTheme(source.theme);

  const seenUrls = new Set();
  state.urlHistory = (Array.isArray(source.urlHistory) ? source.urlHistory : [])
    .map(normalizeUrlEntry)
    .filter((entry) => {
      if (!entry || seenUrls.has(entry.url)) return false;
      seenUrls.add(entry.url);
      return true;
    })
    .slice(0, MAX_URL_HISTORY);

  const seenDownloads = new Set();
  state.downloadHistory = (Array.isArray(source.downloadHistory) ? source.downloadHistory : [])
    .map(normalizeDownloadEntry)
    .filter((entry) => {
      if (!entry || seenDownloads.has(entry.id)) return false;
      seenDownloads.add(entry.id);
      return true;
    })
    .slice(0, MAX_DOWNLOAD_HISTORY);

  return state;
}

function stateFilePath(userDataDirectory) {
  return path.join(path.resolve(userDataDirectory), STATE_FILE_NAME);
}

function loadState(userDataDirectory) {
  const filePath = stateFilePath(userDataDirectory);
  try {
    if (!fs.existsSync(filePath)) return { state: emptyState(), error: '' };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { state: normalizeState(parsed), error: '' };
  } catch {
    return {
      state: emptyState(),
      error: 'Saved history could not be read. Starting with an empty history.',
    };
  }
}

function saveState(userDataDirectory, state) {
  const directory = path.resolve(userDataDirectory);
  const filePath = stateFilePath(directory);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(normalizeState(state), null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function rememberUrl(state, rawUrl, now = new Date()) {
  const url = parseHttpUrl(rawUrl).href;
  const nextEntry = {
    url,
    visitedAt: normalizeTimestamp(now),
  };
  const current = normalizeState(state);
  return {
    ...current,
    urlHistory: [nextEntry, ...current.urlHistory.filter((entry) => entry.url !== url)]
      .slice(0, MAX_URL_HISTORY),
  };
}

function addDownloadHistory(state, value, idFactory = () => `${Date.now()}-${Math.random()}`) {
  const current = normalizeState(state);
  const entry = normalizeDownloadEntry({
    ...value,
    id: value?.id || idFactory(),
  });
  if (!entry) return current;

  return {
    ...current,
    downloadHistory: [entry, ...current.downloadHistory.filter((item) => item.id !== entry.id)]
      .slice(0, MAX_DOWNLOAD_HISTORY),
  };
}

function clearUrlHistory(state) {
  return { ...normalizeState(state), urlHistory: [] };
}

function clearDownloadHistory(state) {
  return { ...normalizeState(state), downloadHistory: [] };
}

module.exports = {
  MAX_DOWNLOAD_HISTORY,
  MAX_URL_HISTORY,
  addDownloadHistory,
  clearDownloadHistory,
  clearUrlHistory,
  emptyState,
  loadState,
  normalizeState,
  rememberUrl,
  saveState,
  stateFilePath,
};

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { classifyPlatform, normalizePlatformUrl, youtubeVideoUrl } = require('./site-policy');
const { findStagedOutput, publishStagedOutput } = require('./media-output');

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const MAX_PLAYLIST_ENTRIES = 100;
const BASE_ARGS = ['--ignore-config', '--no-cache-dir', '--no-update', '--no-warnings', '--no-color'];

class YtDlpError extends Error {
  constructor(message, code = 'YTDLP_ERROR', details = {}) {
    super(message);
    this.name = 'YtDlpError';
    this.code = code;
    Object.assign(this, details);
  }
}

function resourceRoot() {
  return path.resolve(__dirname, '..', '..');
}

function getHelperDirectory(options = {}) {
  if (options.helperDirectory) return path.resolve(options.helperDirectory);
  if (options.packaged) {
    return path.join(options.resourcesPath || process.resourcesPath || resourceRoot(), 'bin');
  }
  return path.join(options.appPath || resourceRoot(), 'bin');
}

function localBinaryPath(name, options = {}) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  return path.join(getHelperDirectory(options), executable);
}

function resolveBinary(name, explicitPath, options = {}) {
  if (explicitPath) return explicitPath;
  return localBinaryPath(name, options);
}

function resolveYtDlp(options = {}) {
  return resolveBinary('yt-dlp', options.executable, options);
}

function resolveFfmpeg(options = {}) {
  const candidate = options.ffmpegPath || localBinaryPath('ffmpeg', options);
  return fs.existsSync(candidate) ? candidate : '';
}

function resolveFfprobe(options = {}) {
  const candidate = options.ffprobePath || localBinaryPath('ffprobe', options);
  return fs.existsSync(candidate) ? candidate : '';
}

function resolveDeno(options = {}) {
  const candidate = options.denoPath || localBinaryPath('deno', options);
  return fs.existsSync(candidate) ? candidate : '';
}

function runtimeArgs(options = {}) {
  const deno = resolveDeno(options);
  return deno
    ? ['--no-js-runtimes', '--js-runtimes', `deno:${deno}`, '--no-remote-components']
    : [];
}

function buildMetadataArgs({ playlist = false, flatPlaylist = false, ...options } = {}) {
  return [
    ...BASE_ARGS,
    ...runtimeArgs(options),
    '--skip-download',
    '--dump-single-json',
    ...(playlist ? [] : ['--no-playlist']),
    ...(flatPlaylist ? ['--flat-playlist'] : []),
  ];
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeFormat(format) {
  if (!format || !format.format_id || format.vcodec === 'none') return null;
  // Public LinkedIn MP4 sources may omit codec and resolution metadata entirely.
  // Keep those formats, but do not turn unknown/audio-only sources into video.
  if (!format.vcodec && !format.height && !format.width
    && !['mp4', 'webm', 'mov', 'mkv', 'flv', '3gp', 'avi', 'm4v'].includes(String(format.ext || '').toLowerCase())) return null;
  const height = toFiniteNumber(format.height);
  const width = toFiniteNumber(format.width);
  return {
    id: String(format.format_id),
    ext: String(format.ext || '').toLowerCase(),
    width,
    height,
    resolution: format.resolution || (height ? `${width || '?'}x${height}` : 'audio/video'),
    fps: toFiniteNumber(format.fps),
    videoCodec: String(format.vcodec || ''),
    audioCodec: String(format.acodec || ''),
    hasAudio: Boolean(format.acodec && format.acodec !== 'none'),
    protocol: String(format.protocol || ''),
    fileSize: toFiniteNumber(format.filesize) || toFiniteNumber(format.filesize_approx),
    bitrate: toFiniteNumber(format.tbr),
  };
}

function normalizeFormats(formats) {
  const unique = new Map();
  for (const format of Array.isArray(formats) ? formats : []) {
    const normalized = normalizeFormat(format);
    if (!normalized) continue;
    const current = unique.get(normalized.id);
    if (!current || (normalized.hasAudio && !current.hasAudio)) unique.set(normalized.id, normalized);
  }

  return [...unique.values()].sort((left, right) => {
    const heightDifference = (right.height || 0) - (left.height || 0);
    if (heightDifference) return heightDifference;
    if (left.hasAudio !== right.hasAudio) return left.hasAudio ? -1 : 1;
    return (right.bitrate || 0) - (left.bitrate || 0);
  });
}

function resolutionOptions(formats) {
  const values = Array.isArray(formats) && formats.some((format) => format && format.id && !format.format_id)
    ? formats
    : normalizeFormats(formats);
  return [...new Set(
    values
      .map((format) => format.height)
      .filter((height) => Number.isFinite(height) && height > 0),
  )].sort((left, right) => right - left);
}

function normalizeMediaInfo(info, url, platform = classifyPlatform(url)) {
  const formats = normalizeFormats(info.formats);
  return {
    id: String(info.id || ''),
    url,
    platform,
    title: String(info.title || 'Untitled video'),
    description: String(info.description || '').slice(0, 500),
    uploader: String(info.uploader || info.channel || ''),
    duration: toFiniteNumber(info.duration),
    uploadDate: String(info.upload_date || ''),
    timestamp: toFiniteNumber(info.timestamp),
    thumbnail: '',
    formats,
    resolutions: resolutionOptions(formats),
    extractor: String(info.extractor_key || info.extractor || ''),
    isLive: Boolean(info.is_live),
  };
}

function normalizePlaylistEntry(entry, originalIndex) {
  const id = String(entry?.id || '');
  const url = entry?.webpage_url || youtubeVideoUrl(id);
  if (!url) return null;

  return {
    id,
    url,
    title: String(entry?.title || 'Untitled video'),
    uploadDate: String(entry?.upload_date || ''),
    timestamp: toFiniteNumber(entry?.timestamp),
    duration: toFiniteNumber(entry?.duration),
    originalIndex: toFiniteNumber(entry?.playlist_index) || originalIndex,
    available: true,
    error: '',
  };
}

function safeJsonParse(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new YtDlpError('yt-dlp returned no metadata.', 'EMPTY_METADATA');

  try {
    return JSON.parse(text);
  } catch {
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(text.slice(objectStart, objectEnd + 1));
      } catch {
        // Fall through to the user-facing parse error.
      }
    }
    throw new YtDlpError('yt-dlp returned unreadable metadata.', 'INVALID_METADATA');
  }
}

function makeAbortError() {
  return new YtDlpError('The operation was canceled.', 'ABORT_ERR');
}

function safeAppend(current, value, maxBytes) {
  const next = current + String(value || '');
  return next.length > maxBytes ? next.slice(-maxBytes) : next;
}

function killProcessTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;

  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {});
    return;
  }

  child.kill('SIGTERM');
}

function splitLines(buffer, onLine) {
  let pending = '';
  return (chunk) => {
    pending += String(chunk || '');
    const lines = pending.split(/\r?\n|\r/);
    pending = lines.pop() || '';
    for (const line of lines) onLine(line);
  };
}

function runProcess(args, options = {}) {
  const executable = options.executable || resolveYtDlp(options);
  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(executable, args, {
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      YTDLP_NO_UPDATE: '1',
      ...(options.env || {}),
    },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let canceled = false;
  let resolvePromise;
  let rejectPromise;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const onStdoutLine = splitLines('', (line) => {
    if (typeof options.onStdoutLine === 'function') options.onStdoutLine(line);
  });
  const onStderrLine = splitLines('', (line) => {
    if (typeof options.onStderrLine === 'function') options.onStderrLine(line);
  });

  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    if (error) rejectPromise(error);
    else resolvePromise({ ...result, stdout, stderr, canceled });
  };

  child.stdout?.on('data', (chunk) => {
    stdout = safeAppend(stdout, chunk, MAX_METADATA_BYTES);
    onStdoutLine(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = safeAppend(stderr, chunk, MAX_STDERR_BYTES);
    onStderrLine(chunk);
  });
  child.on('error', (error) => {
    const toolName = path.basename(executable).replace(/\.exe$/i, '');
    if (error.code === 'ENOENT') {
      finish(new YtDlpError(`${toolName} is missing from the bundled media tools. Reinstall Resource Radar.`, 'MISSING_EXECUTABLE'));
    } else {
      finish(new YtDlpError(error.message || 'yt-dlp could not start.', error.code || 'START_ERROR'));
    }
  });
  child.on('close', (code, signal) => {
    if (canceled) {
      finish(makeAbortError(), { code, signal });
      return;
    }
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
      const message = detail || `yt-dlp exited with code ${code ?? 'unknown'}.`;
      finish(new YtDlpError(message, 'PROCESS_EXIT', { exitCode: code, signal }));
      return;
    }
    finish(null, { code, signal });
  });

  const cancel = () => {
    if (settled || canceled) return;
    canceled = true;
    killProcessTree(child);
  };

  if (options.signal) {
    if (options.signal.aborted) cancel();
    else options.signal.addEventListener('abort', cancel, { once: true });
  }
  if (typeof options.onProcess === 'function') options.onProcess({ child, cancel });

  return { child, promise, cancel };
}

async function runJson(url, options = {}) {
  const task = runProcess([
    ...buildMetadataArgs({ ...options, playlist: options.playlist, flatPlaylist: options.flatPlaylist }),
    '--',
    url,
  ], options);
  const result = await task.promise;
  return safeJsonParse(result.stdout);
}

function firstOutputLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

async function checkTool(label, executable, args, options = {}) {
  if (!executable || !fs.existsSync(executable)) {
    return {
      name: label,
      available: false,
      path: executable || '',
      version: '',
      error: `${label} is not included in this installation.`,
    };
  }

  try {
    const task = runProcess(args, { ...options, executable });
    const result = await task.promise;
    return {
      name: label,
      available: true,
      path: executable,
      version: firstOutputLine(result.stdout) || firstOutputLine(result.stderr),
      error: '',
    };
  } catch (error) {
    return {
      name: label,
      available: false,
      path: executable,
      version: '',
      error: error.message,
    };
  }
}

async function getToolStatus(options = {}) {
  const tools = await Promise.all([
    checkTool('yt-dlp', resolveYtDlp(options), ['--version'], options),
    checkTool('ffmpeg', resolveFfmpeg(options), ['-version'], options),
    checkTool('ffprobe', resolveFfprobe(options), ['-version'], options),
    checkTool('Deno', resolveDeno(options), ['--version'], options),
  ]);
  const [ytDlp, ffmpeg, ffprobe, deno] = tools;
  const ready = tools.every((tool) => tool.available);

  return {
    ready,
    available: ytDlp.available,
    executable: ytDlp.path,
    version: ytDlp.version,
    ffmpeg: ffmpeg.available,
    ffprobe: ffprobe.available,
    deno: deno.available,
    helperDirectory: getHelperDirectory(options),
    tools,
    error: ready ? '' : tools.filter((tool) => !tool.available).map((tool) => `${tool.name}: ${tool.error}`).join(' '),
  };
}

async function extractMediaInfo(rawUrl, options = {}) {
  const normalized = normalizePlatformUrl(rawUrl);
  if (!normalized.url.href) throw new YtDlpError('The media URL is empty.', 'INVALID_URL');
  const info = await runJson(normalized.url.href, options);
  return normalizeMediaInfo(info, normalized.url.href, normalized.platform);
}

async function extractPlaylistInfo(rawUrl, options = {}) {
  const normalized = normalizePlatformUrl(rawUrl, { allowPlaylist: true });
  if (normalized.platform !== 'youtube' || !normalized.playlist) {
    throw new YtDlpError('Only YouTube playlist URLs are supported for playlist downloads.', 'INVALID_PLAYLIST');
  }

  const playlistInfo = await runJson(normalized.url.href, { ...options, playlist: true, flatPlaylist: true });
  const rawEntries = Array.isArray(playlistInfo.entries) ? playlistInfo.entries : [];
  const entries = rawEntries
    .map((entry, index) => normalizePlaylistEntry(entry, index + 1))
    .filter(Boolean);

  if (entries.length > (options.maxEntries || MAX_PLAYLIST_ENTRIES)) {
    throw new YtDlpError(
      `This playlist has ${entries.length} entries. Resource Radar currently supports up to ${options.maxEntries || MAX_PLAYLIST_ENTRIES} per queue.`,
      'PLAYLIST_TOO_LARGE',
    );
  }

  const hydrated = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    try {
      const info = await runJson(entry.url, { ...options, playlist: false });
      const normalizedItem = normalizeMediaInfo(info, entry.url, 'youtube');
      hydrated.push({
        ...entry,
        ...normalizedItem,
        originalIndex: entry.originalIndex,
        available: true,
        error: '',
      });
    } catch (error) {
      hydrated.push({ ...entry, available: false, error: error.message });
    }

    if (typeof options.onPlaylistProgress === 'function') {
      options.onPlaylistProgress({ completed: index + 1, total: entries.length, title: entry.title });
    }
  }

  return {
    id: String(playlistInfo.id || normalized.url.searchParams.get('list') || ''),
    title: String(playlistInfo.title || 'YouTube playlist'),
    url: normalized.url.href,
    uploader: String(playlistInfo.uploader || playlistInfo.channel || ''),
    entries: hydrated,
  };
}

function parseProgressLine(line) {
  let value = String(line || '').trim();
  if (value.startsWith('download:')) value = value.slice('download:'.length);
  if (value.startsWith('RR_PROGRESS|')) value = value.slice('RR_PROGRESS|'.length);
  const fields = value.split('|');
  if (fields.length !== 5) return null;
  const [downloaded, total, speed, eta, status] = fields;
  const downloadedBytes = toFiniteNumber(downloaded);
  const totalBytes = toFiniteNumber(total);
  if (downloadedBytes === null && totalBytes === null) return null;
  return {
    downloadedBytes,
    totalBytes,
    speed: speed === 'NA' ? '' : speed,
    eta: eta === 'NA' ? '' : eta,
    status: status || '',
    percent: totalBytes && downloadedBytes !== null ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null,
  };
}

function formatSelector(maxHeight) {
  const height = Number(maxHeight);
  if (!Number.isFinite(height) || height <= 0) return 'bv*+ba/b';
  return `bv*[height<=${Math.floor(height)}]+ba/b[height<=${Math.floor(height)}]/b[height<=${Math.floor(height)}]`;
}

function isInsideDirectory(candidate, directory) {
  const root = path.resolve(directory);
  const target = path.resolve(candidate);
  return target !== root && target.startsWith(`${root}${path.sep}`);
}

function findFinalPath(stdout, downloadDirectory) {
  const root = path.resolve(downloadDirectory);
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, '').replace(/[\u001b\u009b]\[[0-?]*[ -/]*[@-~]/g, '').trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    const candidate = path.isAbsolute(line) ? path.resolve(line) : path.resolve(root, line);
    if (isInsideDirectory(candidate, root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return '';
}

function findFinalPathById(downloadDirectory, expectedId) {
  const root = path.resolve(downloadDirectory);
  const marker = `[${String(expectedId || '').trim()}]`;
  if (marker.length <= 2 || !fs.existsSync(root)) return '';

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }

  const matches = entries
    .filter((entry) => entry.isFile() && entry.name.includes(marker) && !/\.(?:part|ytdl|frag\d+)$/i.test(entry.name))
    .map((entry) => path.resolve(root, entry.name))
    .filter((candidate) => isInsideDirectory(candidate, root));

  return matches.length === 1 ? matches[0] : '';
}

function findDownloadOutput(stdout, downloadDirectory, expectedId) {
  return findFinalPath(stdout, downloadDirectory) || findFinalPathById(downloadDirectory, expectedId);
}

async function downloadMedia({
  url,
  downloadDirectory,
  maxHeight,
  order = null,
  signal,
  options = {},
  onProgress,
  onProcess,
}) {
  const normalized = normalizePlatformUrl(url);
  const ffmpeg = resolveFfmpeg(options);
  const helperDirectory = getHelperDirectory(options);
  const prefix = Number.isInteger(order) && order > 0 ? `${order}. ` : '';
  const outputTemplate = `${prefix}%(title)s.%(ext)s`;
  const root = path.resolve(downloadDirectory);
  let canceled = false;
  const checkCanceled = () => {
    if (canceled || signal?.aborted) throw makeAbortError();
  };

  checkCanceled();
  await fs.promises.mkdir(root, { recursive: true });
  checkCanceled();
  const stagingDirectory = await fs.promises.mkdtemp(path.join(root, '.resource-radar-'));

  try {
    checkCanceled();
    const args = [
      ...BASE_ARGS,
      ...runtimeArgs(options),
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template', 'download:RR_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s|%(progress.status)s',
      '--paths', `home:${stagingDirectory}`,
      '--paths', `temp:${path.join(stagingDirectory, 'parts')}`,
      '--output', outputTemplate,
      '--windows-filenames',
      '--trim-filenames', '160',
      '--no-overwrites',
      '--format', formatSelector(maxHeight),
    ];

    if (ffmpeg) args.push('--ffmpeg-location', helperDirectory);
    args.push('--print', 'after_move:filepath', '--', normalized.url.href);

    const task = runProcess(args, {
      ...options,
      signal,
      onProcess: (handle) => {
        if (typeof onProcess === 'function') {
          onProcess({
            ...handle,
            cancel: () => {
              canceled = true;
              handle.cancel();
            },
          });
        }
      },
      onStdoutLine: (line) => {
        const progress = parseProgressLine(line);
        if (progress && typeof onProgress === 'function') onProgress(progress);
      },
    });

    const result = await task.promise;
    checkCanceled();
    const stagedPath = findStagedOutput(result.stdout, stagingDirectory);
    if (!stagedPath) {
      throw new YtDlpError('yt-dlp finished without a completed video in its staging folder.', 'MISSING_OUTPUT', {
        stderr: result.stderr,
      });
    }
    const finalPath = await publishStagedOutput(stagedPath, stagingDirectory, root, checkCanceled);

    return {
      path: finalPath,
      fileName: path.basename(finalPath),
      url: normalized.url.href,
      platform: normalized.platform,
      maxHeight: Number.isFinite(Number(maxHeight)) ? Number(maxHeight) : null,
      output: result.stdout,
    };
  } finally {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = {
  BASE_ARGS,
  YtDlpError,
  buildMetadataArgs,
  downloadMedia,
  extractMediaInfo,
  extractPlaylistInfo,
  findFinalPath,
  findFinalPathById,
  findDownloadOutput,
  formatSelector,
  getToolStatus,
  normalizeFormat,
  normalizeFormats,
  normalizeMediaInfo,
  parseProgressLine,
  resolutionOptions,
  getHelperDirectory,
  resolveDeno,
  resolveFfmpeg,
  resolveFfprobe,
  resolveYtDlp,
  runJson,
  runProcess,
};

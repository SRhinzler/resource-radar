const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const dns = require('node:dns').promises;
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { resolvePublicHost } = require('./url-policy');

const UPDATE_OWNER = 'SRhinzler';
const UPDATE_REPOSITORY = 'resource-radar';
const API_HOST = 'api.github.com';
const APPROVED_ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const RELEASES_API_URL = `https://${API_HOST}/repos/${UPDATE_OWNER}/${UPDATE_REPOSITORY}/releases?per_page=30`;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_UPDATE_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const RELEASE_BODY_LIMIT = 250_000;
const SAFE_ASSET_CONTENT_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/x-msdownload',
  'application/vnd.microsoft.portable-executable',
  'binary/octet-stream',
]);

class UpdateError extends Error {
  constructor(message, code = 'UPDATE_ERROR') {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

function parseSemver(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200) return null;
  const match = /^v?(\d+(?:\.\d+){0,2})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(text);
  if (!match) return null;

  const numbers = match[1].split('.');
  if (numbers.some((part) => part.length > 1 && part.startsWith('0'))) return null;
  const prerelease = match[2] ? match[2].split('.') : [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;

  const major = Number(numbers[0]);
  const minor = Number(numbers[1] || 0);
  const patch = Number(numbers[2] || 0);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return null;

  return {
    major,
    minor,
    patch,
    prerelease,
  };
}

function isValidSemver(value) {
  return Boolean(parseSemver(value));
}

function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new UpdateError('The update version is not a valid semantic version.', 'INVALID_VERSION');

  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^(0|[1-9]\d*)$/.test(leftPart);
    const rightNumeric = /^(0|[1-9]\d*)$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart);
      const rightNumber = BigInt(rightPart);
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

function assertHttpsGithubUrl(value, kind) {
  let url;
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) {
      throw new Error('Invalid URL characters.');
    }
    url = new URL(value);
  } catch {
    throw new UpdateError('GitHub returned an invalid update URL.', 'INVALID_UPDATE_URL');
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || value.includes('#')) {
    throw new UpdateError('Update URLs must use HTTPS without credentials.', 'INVALID_UPDATE_URL');
  }

  if (kind === 'metadata') {
    const expectedPrefix = `/repos/${UPDATE_OWNER}/${UPDATE_REPOSITORY}/releases`;
    if (host !== API_HOST || (url.pathname !== expectedPrefix && !url.pathname.startsWith(`${expectedPrefix}/`))) {
      throw new UpdateError('The update metadata URL is outside the Resource Radar GitHub repository.', 'INVALID_UPDATE_URL');
    }
  } else {
    if (!APPROVED_ASSET_HOSTS.has(host) || !url.pathname || url.pathname.includes('..')) {
      throw new UpdateError('The Windows installer URL is not an approved GitHub release asset.', 'INVALID_UPDATE_URL');
    }
    if (host === 'github.com' && !url.pathname.toLowerCase().startsWith(`/${UPDATE_OWNER.toLowerCase()}/${UPDATE_REPOSITORY.toLowerCase()}/releases/download/`)) {
      throw new UpdateError('The Windows installer URL is not a Resource Radar release asset.', 'INVALID_UPDATE_URL');
    }
  }

  return url;
}

function isAllowedReleaseAssetUrl(value) {
  try {
    assertHttpsGithubUrl(value, 'asset');
    return true;
  } catch {
    return false;
  }
}

function parseAssetDigest(value) {
  if (value === null || value === undefined || value === '') return '';
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(value).trim());
  if (!match) throw new UpdateError('GitHub returned an invalid installer SHA-256 digest.', 'INVALID_DIGEST');
  return `sha256:${match[1].toLowerCase()}`;
}

function validateAssetName(value) {
  const name = typeof value === 'string' ? value : '';
  if (!name || name !== name.trim() || name.length > 240 || name !== path.basename(name)) {
    throw new UpdateError('GitHub returned an invalid installer name.', 'INVALID_ASSET');
  }
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) || !/\.exe$/i.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new UpdateError('The latest release does not include a safe Windows installer.', 'INVALID_ASSET');
  }
  return name;
}

function assertInitialAssetUrl(value, name, expectedTag) {
  const url = assertHttpsGithubUrl(value, 'asset');
  if (url.hostname !== 'github.com' || value.includes('?')) {
    throw new UpdateError('The installer must start at its public GitHub release download URL.', 'INVALID_UPDATE_URL');
  }

  const parts = url.pathname.split('/');
  let tagName;
  let assetName;
  try {
    tagName = decodeURIComponent(parts[5] || '');
    assetName = decodeURIComponent(parts[6] || '');
  } catch {
    throw new UpdateError('The installer release URL contains invalid encoding.', 'INVALID_UPDATE_URL');
  }
  const parsedTag = parseSemver(tagName);
  if (parts.length !== 7 || !parsedTag || parsedTag.prerelease.length
    || tagName !== tagName.trim() || assetName !== name
    || (expectedTag !== undefined && tagName !== expectedTag)) {
    throw new UpdateError('The installer URL does not match the checked release tag and asset name.', 'INVALID_UPDATE_URL');
  }
  return { url, tagName };
}

function normalizeReleaseAsset(asset, expectedTag) {
  if (!asset || typeof asset !== 'object') {
    throw new UpdateError('GitHub returned an invalid installer asset.', 'INVALID_ASSET');
  }

  if (asset.state !== 'uploaded') {
    throw new UpdateError('The Windows installer has not finished uploading to GitHub.', 'INVALID_ASSET');
  }
  const name = validateAssetName(asset.name);
  const size = asset.size;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_ASSET_BYTES) {
    throw new UpdateError('The Windows installer size is outside the allowed limit.', 'INVALID_ASSET_SIZE');
  }

  const contentType = String(asset.content_type || asset.contentType || '').toLowerCase().split(';', 1)[0].trim();
  if (!SAFE_ASSET_CONTENT_TYPES.has(contentType)) {
    throw new UpdateError('The selected release asset is not a Windows executable.', 'INVALID_ASSET_TYPE');
  }

  const { url, tagName } = assertInitialAssetUrl(
    asset.browser_download_url || asset.url,
    name,
    expectedTag === undefined ? asset.tagName : expectedTag,
  );
  return {
    name,
    size,
    state: 'uploaded',
    tagName,
    contentType,
    url: url.href,
    digest: parseAssetDigest(asset.digest),
  };
}

function assetPriority(asset) {
  const name = asset.name.toLowerCase();
  let score = 0;
  if (name.includes('resource-radar')) score += 4;
  if (name.includes('setup') || name.includes('installer')) score += 3;
  if (name.includes('win') || name.includes('windows')) score += 1;
  return score;
}

function selectWindowsReleaseAsset(assets, tagName) {
  if (!Array.isArray(assets)) {
    throw new UpdateError('The latest release does not include a Windows installer.', 'NO_WINDOWS_ASSET');
  }

  const candidates = [];
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || !/\.exe$/i.test(String(asset.name || ''))) continue;
    try {
      candidates.push(normalizeReleaseAsset(asset, tagName));
    } catch (error) {
      if (error.code === 'INVALID_ASSET' || error.code === 'INVALID_ASSET_TYPE' || error.code === 'INVALID_ASSET_SIZE' || error.code === 'INVALID_DIGEST' || error.code === 'INVALID_UPDATE_URL') {
        continue;
      }
      throw error;
    }
  }

  if (!candidates.length) {
    throw new UpdateError('The latest release does not include a safe Windows installer.', 'NO_WINDOWS_ASSET');
  }

  candidates.sort((left, right) => assetPriority(right) - assetPriority(left) || left.name.localeCompare(right.name));
  return candidates[0];
}

function normalizeRelease(release) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null;
  const tagName = String(release.tag_name || '').trim();
  const parsed = parseSemver(tagName);
  if (!parsed || parsed.prerelease.length) return null;

  return {
    tagName,
    version: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    title: String(release.name || tagName).slice(0, 300),
    body: String(release.body || '').slice(0, RELEASE_BODY_LIMIT),
    publishedAt: String(release.published_at || release.created_at || '').slice(0, 64),
    assets: Array.isArray(release.assets) ? release.assets : [],
  };
}

function publicRelease(release, asset) {
  return {
    tagName: release.tagName,
    version: release.version,
    title: release.title,
    body: release.body,
    publishedAt: release.publishedAt,
    assetName: asset.name,
    assetSize: asset.size,
    hasDigest: Boolean(asset.digest),
  };
}

function requestOnce(url, addresses, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request({
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: 'GET',
      headers: options.kind === 'asset'
        ? {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          'User-Agent': 'ResourceRadar/2.0 (update-check)',
          Host: url.host,
        }
        : {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ResourceRadar/2.0 (update-check)',
          Host: url.host,
        },
      servername: url.hostname,
      // Retain all vetted DNS answers so Node can fall back from an unreachable
      // IPv6/NAT64 route to IPv4. Never resolve again after public-address checks.
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      lookup: (_hostname, lookupOptions, callback) => lookupOptions.all
        ? callback(null, addresses)
        : callback(null, addresses[0].address, addresses[0].family),
      timeout: options.timeoutMs || 20_000,
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      settled = true;
      resolve(response);
    });

    request.on('timeout', () => request.destroy(new UpdateError('The GitHub update request timed out.', 'TIMEOUT')));
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof UpdateError ? error : new UpdateError(error.message || 'The GitHub update request failed.', 'NETWORK_ERROR'));
    });

    if (options.signal) {
      const abort = () => request.destroy(new UpdateError('The update download was canceled.', 'ABORTED'));
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => options.signal.removeEventListener('abort', abort));
    }

    request.end();
  });
}

async function requestGithubResponse(input, options = {}) {
  let current = options.kind === 'asset'
    ? assertHttpsGithubUrl(input, 'asset')
    : assertHttpsGithubUrl(input, 'metadata');

  for (let redirectCount = 0; redirectCount <= (options.maxRedirects ?? MAX_REDIRECTS); redirectCount += 1) {
    const addresses = await dns.lookup(current.hostname, { all: true, verbatim: true });
    await resolvePublicHost(current.hostname, async () => addresses);
    const response = await requestOnce(current, addresses, options);
    const statusCode = response.statusCode || 0;

    if (!REDIRECT_STATUS_CODES.has(statusCode)) return { response, url: current, statusCode };

    const location = response.headers.location;
    response.destroy();
    if (!location) throw new UpdateError('GitHub returned a redirect without a destination.', 'BAD_REDIRECT');
    if (redirectCount === (options.maxRedirects ?? MAX_REDIRECTS)) throw new UpdateError('Too many GitHub redirects.', 'TOO_MANY_REDIRECTS');

    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new UpdateError('GitHub returned an invalid redirect.', 'BAD_REDIRECT');
    }
    current = options.kind === 'asset'
      ? assertHttpsGithubUrl(next.href, 'asset')
      : assertHttpsGithubUrl(next.href, 'metadata');
  }

  throw new UpdateError('Unable to follow the GitHub update URL.', 'TOO_MANY_REDIRECTS');
}

function responseContentLength(response) {
  const raw = response.headers?.['content-length'];
  if (raw === undefined) return null;
  if (!/^(0|[1-9]\d*)$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
    throw new UpdateError('GitHub returned an invalid response size.', 'INVALID_RESPONSE');
  }
  return Number(raw);
}

function readLimitedResponse(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };

    response.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        fail(new UpdateError('GitHub returned more update metadata than allowed.', 'RESPONSE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    response.on('error', fail);
    response.on('aborted', () => fail(new UpdateError('The GitHub update response was interrupted.', 'INVALID_RESPONSE')));
    response.on('close', () => {
      if (!done) fail(new UpdateError('The GitHub update response ended early.', 'INVALID_RESPONSE'));
    });
  });
}

async function fetchReleaseList() {
  const opened = await requestGithubResponse(RELEASES_API_URL, { kind: 'metadata' });
  if (opened.statusCode < 200 || opened.statusCode >= 300) {
    opened.response.destroy();
    throw new UpdateError(`GitHub returned HTTP ${opened.statusCode} while checking for updates.`, 'HTTP_ERROR');
  }

  let body;
  try {
    const length = responseContentLength(opened.response);
    if (length !== null && length > MAX_METADATA_BYTES) {
      throw new UpdateError('GitHub returned more update metadata than allowed.', 'RESPONSE_TOO_LARGE');
    }
    body = await readLimitedResponse(opened.response, MAX_METADATA_BYTES);
  } catch (error) {
    opened.response.destroy();
    throw error;
  }
  let releases;
  try {
    releases = JSON.parse(body.toString('utf8'));
  } catch {
    throw new UpdateError('GitHub returned invalid update metadata.', 'BAD_JSON');
  }
  if (!Array.isArray(releases)) throw new UpdateError('GitHub returned unexpected update metadata.', 'BAD_JSON');
  return releases;
}

async function checkLatestRelease(currentVersion, options = {}) {
  if (!isValidSemver(currentVersion)) {
    throw new UpdateError('The installed Resource Radar version is invalid.', 'INVALID_VERSION');
  }

  const releases = options.releases || await (options.fetchReleases || fetchReleaseList)();
  const normalized = releases.map(normalizeRelease).filter(Boolean);
  normalized.sort((left, right) => compareVersions(right.version, left.version));
  const latest = normalized[0];

  if (!latest) {
    return {
      status: 'error',
      currentVersion: String(currentVersion).trim().replace(/^v/i, ''),
      error: 'No published stable Resource Radar release was found.',
    };
  }

  if (compareVersions(latest.version, currentVersion) <= 0) {
    return {
      status: 'up-to-date',
      currentVersion: String(currentVersion).trim().replace(/^v/i, ''),
      latestVersion: latest?.version?.replace(/^v/i, '') || '',
    };
  }

  const asset = selectWindowsReleaseAsset(latest.assets, latest.tagName);
  return {
    status: 'available',
    currentVersion: String(currentVersion).trim().replace(/^v/i, ''),
    latestVersion: latest.version.replace(/^v/i, ''),
    release: {
      ...publicRelease(latest, asset),
      asset,
    },
  };
}

async function downloadReleaseAsset(asset, destinationPath, options = {}) {
  // Only native callers can supply dependencies. Validate before the request seam,
  // and always verify the bytes and file afterward, including for an injected request.
  const normalizedAsset = normalizeReleaseAsset(asset, asset?.tagName);
  const requestResponse = options.requestResponse || requestGithubResponse;
  const destination = path.resolve(String(destinationPath));
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  let fileHandle;
  let createdFile;
  let output;
  let response;
  try {
    if (options.signal?.aborted) throw new UpdateError('The update download was canceled.', 'ABORTED');

    // Reserve exclusively before requesting any bytes. A failed wx must never cause
    // an existing destination to be removed, or leave a network response running.
    fileHandle = await fs.promises.open(destination, 'wx', 0o600);
    createdFile = await fileHandle.stat();
    const opened = await requestResponse(normalizedAsset.url, {
      kind: 'asset',
      signal: options.signal,
    });
    response = opened.response;
    if (opened.statusCode !== 200) {
      throw new UpdateError(`GitHub returned HTTP ${opened.statusCode} while downloading the update.`, 'HTTP_ERROR');
    }
    if (!response || response.aborted || response.destroyed || response.readableEnded) {
      throw new UpdateError('The installer response ended before it could be downloaded.', 'INVALID_RESPONSE');
    }

    const responseLength = responseContentLength(response);
    if (responseLength !== null && (responseLength <= 0 || responseLength > MAX_UPDATE_ASSET_BYTES || responseLength !== normalizedAsset.size)) {
      throw new UpdateError('The downloaded installer size does not match GitHub metadata.', 'SIZE_MISMATCH');
    }
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase().split(';', 1)[0].trim();
    const contentEncoding = String(response.headers?.['content-encoding'] || 'identity').toLowerCase();
    if (!SAFE_ASSET_CONTENT_TYPES.has(contentType) || contentEncoding !== 'identity') {
      throw new UpdateError('GitHub did not return an uncompressed Windows executable.', 'INVALID_RESPONSE');
    }

    const hash = crypto.createHash('sha256');
    let receivedBytes = 0;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_UPDATE_ASSET_BYTES || receivedBytes > normalizedAsset.size) {
            throw new UpdateError('The downloaded installer is larger than GitHub metadata allows.', 'SIZE_MISMATCH');
          }
          hash.update(chunk);
          if (typeof options.onProgress === 'function') {
            options.onProgress({
              receivedBytes,
              totalBytes: normalizedAsset.size,
              percent: Math.round((receivedBytes / normalizedAsset.size) * 100),
            });
          }
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      },
    });
    output = fileHandle.createWriteStream();
    await pipeline(response, progress, output, { signal: options.signal });

    if (response.aborted || response.complete === false || receivedBytes <= 0 || receivedBytes !== normalizedAsset.size) {
      throw new UpdateError('The downloaded installer is incomplete.', 'SIZE_MISMATCH');
    }

    const savedFile = await fs.promises.lstat(destination);
    if (!savedFile.isFile() || savedFile.isSymbolicLink() || savedFile.dev !== createdFile.dev
      || savedFile.ino !== createdFile.ino || savedFile.size !== normalizedAsset.size) {
      throw new UpdateError('The saved installer file could not be verified.', 'SIZE_MISMATCH');
    }
    const sha256 = hash.digest('hex');
    if (normalizedAsset.digest && normalizedAsset.digest.slice('sha256:'.length) !== sha256) {
      throw new UpdateError('The downloaded installer failed its SHA-256 verification.', 'DIGEST_MISMATCH');
    }
    if (options.signal?.aborted) throw new UpdateError('The update download was canceled.', 'ABORTED');

    return {
      path: destination,
      size: receivedBytes,
      sha256,
      digestVerified: Boolean(normalizedAsset.digest),
      asset: normalizedAsset,
    };
  } catch (error) {
    response?.destroy();
    output?.destroy();
    await fileHandle?.close().catch(() => {});
    if (createdFile) {
      try {
        const candidate = await fs.promises.lstat(destination);
        if (candidate.isFile() && !candidate.isSymbolicLink()
          && candidate.dev === createdFile.dev && candidate.ino === createdFile.ino) {
          await fs.promises.unlink(destination);
        }
      } catch {
        // Preserve the original error. Never remove an existing or replaced file.
      }
    }
    throw error instanceof UpdateError ? error : new UpdateError(error.message || 'The update download failed.', 'DOWNLOAD_ERROR');
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

module.exports = {
  API_HOST,
  APPROVED_ASSET_HOSTS,
  MAX_METADATA_BYTES,
  MAX_REDIRECTS,
  MAX_UPDATE_ASSET_BYTES,
  RELEASES_API_URL,
  UpdateError,
  checkLatestRelease,
  compareVersions,
  downloadReleaseAsset,
  isAllowedReleaseAssetUrl,
  isValidSemver,
  normalizeReleaseAsset,
  parseSemver,
  selectWindowsReleaseAsset,
};

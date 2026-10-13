const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { classifyResource, kindFromMime } = require('./resource-types');
const { openPublicResponse } = require('./network');
const { suggestedFileName, uniqueDestination } = require('./safe-file');

function isHtmlResponse(contentType) {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

function describeDownloadError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'Download canceled.';
  if (error?.code === 'HTTP_ERROR') return error.message;
  return error?.message || 'The download failed.';
}

function calculateTransferProgress(receivedBytes, expectedBytes, elapsedMs) {
  const received = Number.isFinite(Number(receivedBytes)) ? Math.max(0, Number(receivedBytes)) : 0;
  const expected = Number.isFinite(Number(expectedBytes)) && Number(expectedBytes) > 0 ? Number(expectedBytes) : null;
  const elapsedSeconds = Number.isFinite(Number(elapsedMs)) && Number(elapsedMs) > 0 ? Number(elapsedMs) / 1000 : 0;
  const speedBytesPerSecond = elapsedSeconds > 0 ? received / elapsedSeconds : null;
  const remainingBytes = expected === null ? null : Math.max(0, expected - received);
  return {
    receivedBytes: received,
    expectedBytes: expected,
    percent: expected === null ? null : Math.min(100, (received / expected) * 100),
    speedBytesPerSecond,
    etaSeconds: speedBytesPerSecond > 0 && remainingBytes !== null ? remainingBytes / speedBytesPerSecond : null,
  };
}

async function reserveDestination(downloadDirectory, desiredName) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const destination = await uniqueDestination(downloadDirectory, desiredName);
    const partPath = `${destination}.part`;

    try {
      const handle = await fsp.open(partPath, 'wx');
      await handle.close();
      return { destination, partPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  throw new Error('Could not reserve an unused filename in the Downloads folder.');
}

async function downloadResource(resource, options = {}) {
  const opened = await openPublicResponse(resource.url, {
    method: 'GET',
    maxRedirects: 5,
    timeoutMs: options.timeoutMs ?? 60_000,
    signal: options.signal,
  });

  if (opened.statusCode < 200 || opened.statusCode >= 300) {
    opened.response.resume();
    const error = new Error(`The resource returned HTTP ${opened.statusCode}.`);
    error.code = 'HTTP_ERROR';
    throw error;
  }

  const mimeKind = kindFromMime(opened.contentType);
  const detectedKind = classifyResource(opened.finalUrl, opened.contentType) || resource.kind;
  if (isHtmlResponse(opened.contentType) || !detectedKind || detectedKind === 'unknown') {
    opened.response.resume();
    throw new Error('The URL did not return a supported direct video or document file.');
  }

  if (resource.kind && resource.kind !== 'unknown' && mimeKind && resource.kind !== mimeKind) {
    opened.response.resume();
    throw new Error('The server returned a different resource type than expected.');
  }

  await fsp.mkdir(options.downloadDirectory, { recursive: true });
  const desiredName = suggestedFileName({
    url: opened.finalUrl,
    headers: opened.response.headers,
    kind: detectedKind,
  });
  const { destination, partPath } = await reserveDestination(options.downloadDirectory, desiredName);
  const expectedBytes = Number.isFinite(Number(opened.contentLength)) && Number(opened.contentLength) > 0
    ? Number(opened.contentLength)
    : null;
  let receivedBytes = 0;
  const startedAt = process.hrtime.bigint();
  let lastProgressAt = -Infinity;

  const emitProgress = (force = false) => {
    if (typeof options.onProgress !== 'function') return;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (!force && elapsedMs - lastProgressAt < 100) return;
    lastProgressAt = elapsedMs;
    options.onProgress(calculateTransferProgress(receivedBytes, expectedBytes, elapsedMs));
  };

  try {
    const writer = fs.createWriteStream(partPath, { flags: 'w' });
    opened.response.on('data', (chunk) => {
      receivedBytes += chunk.length;
      emitProgress();
    });

    await pipeline(opened.response, writer, { signal: options.signal });
    emitProgress(true);
    if (receivedBytes === 0) throw new Error('The server returned an empty file.');
    await fsp.rename(partPath, destination);

    return {
      fileName: path.basename(destination),
      path: destination,
      bytes: receivedBytes,
      contentType: opened.contentType,
      finalUrl: opened.finalUrl,
      kind: detectedKind,
    };
  } catch (error) {
    await fsp.unlink(partPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  calculateTransferProgress,
  describeDownloadError,
  downloadResource,
};

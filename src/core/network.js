const http = require('node:http');
const https = require('node:https');
const { assertPublicUrl } = require('./url-policy');
const { classifyResource, normalizeMime } = require('./resource-types');

const DEFAULT_USER_AGENT = 'ResourceRadar/1.0 (public-resource-downloader)';
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

class NetworkError extends Error {
  constructor(message, code = 'NETWORK_ERROR') {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
  }
}

function createAbortError() {
  const error = new Error('The operation was canceled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function getResponseContentType(response) {
  return normalizeMime(response.headers['content-type'] || '');
}

function getContentLength(response) {
  const value = Number.parseInt(response.headers['content-length'], 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function makeRequest(url, address, family, options = {}) {
  const transport = url.protocol === 'https:' ? https : http;
  const requestHeaders = {
    Accept: 'text/html,application/xhtml+xml,application/pdf,video/*,application/octet-stream;q=0.8,*/*;q=0.1',
    'User-Agent': DEFAULT_USER_AGENT,
    ...options.headers,
    Host: url.host,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const requestOptions = {
      protocol: url.protocol,
      hostname: address,
      port: url.port || undefined,
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: options.method || 'GET',
      headers: requestHeaders,
      family,
      timeout: options.timeoutMs || 20_000,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    };

    if (url.protocol === 'https:' && !/^[\d.:[\]]+$/.test(url.hostname)) {
      requestOptions.servername = url.hostname;
    }

    const request = transport.request(requestOptions, (response) => {
      settled = true;
      resolve(response);
    });

    request.on('timeout', () => {
      request.destroy(new NetworkError('The request timed out.', 'TIMEOUT'));
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        reject(createAbortError());
      } else {
        reject(new NetworkError(error.message || 'The network request failed.', error.code || 'NETWORK_ERROR'));
      }
    });

    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(createAbortError());
        return;
      }
      options.signal.addEventListener('abort', () => request.destroy(createAbortError()), { once: true });
    }

    request.end();
  });
}

async function openPublicResponse(input, options = {}) {
  let current = new URL(input).href;
  const maxRedirects = options.maxRedirects ?? 5;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const checked = await assertPublicUrl(current);
    const response = await makeRequest(checked.url, checked.address, checked.family, options);
    const statusCode = response.statusCode || 0;

    if (!REDIRECT_STATUS_CODES.has(statusCode)) {
      return {
        response,
        finalUrl: checked.url.href,
        statusCode,
        contentType: getResponseContentType(response),
        contentLength: getContentLength(response),
      };
    }

    const location = response.headers.location;
    response.resume();
    if (!location) {
      throw new NetworkError('The server returned a redirect without a destination.', 'BAD_REDIRECT');
    }

    if (redirectCount === maxRedirects) {
      throw new NetworkError('Too many redirects.', 'TOO_MANY_REDIRECTS');
    }

    try {
      current = new URL(location, checked.url).href;
    } catch {
      throw new NetworkError('The server returned an invalid redirect.', 'BAD_REDIRECT');
    }
  }

  throw new NetworkError('Unable to follow the resource URL.', 'TOO_MANY_REDIRECTS');
}

function closeResponse(response) {
  response.resume();
}

function readResponse(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let finished = false;

    const fail = (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };

    response.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        fail(new NetworkError('The response is larger than the allowed limit.', 'RESPONSE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    response.on('error', (error) => fail(error));
  });
}

async function fetchPageHtml(input, options = {}) {
  const opened = await openPublicResponse(input, {
    method: 'GET',
    maxRedirects: options.maxRedirects ?? 5,
    timeoutMs: options.timeoutMs ?? 20_000,
    signal: options.signal,
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
  });

  if (opened.statusCode < 200 || opened.statusCode >= 300) {
    closeResponse(opened.response);
    throw new NetworkError(`The webpage returned HTTP ${opened.statusCode}.`, 'HTTP_ERROR');
  }

  const body = await readResponse(opened.response, options.maxBytes ?? 8 * 1024 * 1024);
  return { ...opened, body: body.toString('utf8') };
}

async function probeResource(input, options = {}) {
  let opened = await openPublicResponse(input, {
    method: 'HEAD',
    maxRedirects: options.maxRedirects ?? 5,
    timeoutMs: options.timeoutMs ?? 15_000,
    signal: options.signal,
  });

  if (opened.statusCode < 200 || opened.statusCode >= 300) {
    closeResponse(opened.response);
    opened = await openPublicResponse(input, {
      method: 'GET',
      maxRedirects: options.maxRedirects ?? 5,
      timeoutMs: options.timeoutMs ?? 15_000,
      signal: options.signal,
      headers: { Range: 'bytes=0-0' },
    });
  } else {
    closeResponse(opened.response);
  }

  const contentType = opened.contentType;
  const kind = classifyResource(opened.finalUrl, contentType) || options.fallbackKind;
  const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
  const supported = opened.statusCode >= 200 && opened.statusCode < 300 && !isHtml && Boolean(kind);
  closeResponse(opened.response);

  return {
    finalUrl: opened.finalUrl,
    statusCode: opened.statusCode,
    contentType,
    contentLength: opened.contentLength,
    kind,
    supported,
  };
}

module.exports = {
  NetworkError,
  closeResponse,
  createAbortError,
  fetchPageHtml,
  getContentLength,
  getResponseContentType,
  openPublicResponse,
  probeResource,
  readResponse,
};

const { openPublicResponse } = require('./network');
const { parseHttpUrl } = require('./url-policy');
const { classifyPlatform, isLinkedInShortUrl, isYoutubePlaylistUrl, normalizePlatformUrl } = require('./site-policy');

const MAX_SHORT_LINK_REDIRECTS = 5;
const SHORT_LINK_TIMEOUT_MS = 20_000;

class PlatformInputError extends Error {
  constructor(message, code = 'SHORT_LINK_ERROR') {
    super(message);
    this.name = 'PlatformInputError';
    this.code = code;
  }
}

function normalizeInputResult(rawUrl) {
  const url = parseHttpUrl(rawUrl);
  const platform = classifyPlatform(url.href);
  if (!platform) return { url: url.href, platform: null, playlist: false };

  // Inspection must retain playlist identity. Single-video callers still apply
  // their existing allowPlaylist policy when they prepare the extraction.
  const normalized = normalizePlatformUrl(url.href, { allowPlaylist: isYoutubePlaylistUrl(url.href) });
  return { url: normalized.url.href, platform: normalized.platform, playlist: normalized.playlist };
}

/**
 * Resolve recognized LinkedIn short links before choosing a platform extractor.
 * Ordinary inputs are normalized without a request. The injected opener is a
 * test seam with the same contract as openPublicResponse; production uses its
 * per-hop public-address checks, pinned requests, and bounded redirect policy.
 * options.signal cancels resolution. No caller headers/cookies are forwarded.
 */
async function resolvePlatformInput(rawUrl, options = {}) {
  const input = parseHttpUrl(rawUrl);
  if (!isLinkedInShortUrl(input.href)) return normalizeInputResult(input.href);
  if (input.protocol !== 'https:') throw new Error('Platform video URLs must use HTTPS.');

  const openResponse = options.openPublicResponseImpl || openPublicResponse;
  let opened;
  try {
    // Use GET: short-link services do not always send the same redirects to HEAD.
    // Only response headers are needed, so the body is disposed in finally.
    opened = await openResponse(input.href, {
      method: 'GET',
      maxRedirects: MAX_SHORT_LINK_REDIRECTS,
      timeoutMs: SHORT_LINK_TIMEOUT_MS,
      signal: options.signal,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    });

    const status = opened.statusCode;
    if (status === 404 || status === 410) {
      throw new PlatformInputError(
        `This LinkedIn short link has expired or is no longer available (HTTP ${status}). Ask for a fresh link or paste the full public destination URL.`,
        'SHORT_LINK_EXPIRED',
      );
    }
    if ([401, 403, 407, 423, 429, 999].includes(status)) {
      throw new PlatformInputError(
        `The LinkedIn short link is blocked or requires sign-in (HTTP ${status}). Try again later or paste a public destination URL that is accessible without signing in.`,
        'SHORT_LINK_BLOCKED',
      );
    }
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new PlatformInputError(
        `The LinkedIn short link could not be opened${Number.isInteger(status) ? ` (HTTP ${status})` : ''}. Paste the full public destination URL or try again later.`,
        'SHORT_LINK_HTTP_ERROR',
      );
    }
    if (typeof opened.finalUrl !== 'string' || !opened.finalUrl.trim()) {
      throw new PlatformInputError('The LinkedIn short link returned no destination. Paste the full public post or destination URL instead.', 'SHORT_LINK_UNRESOLVED');
    }
    if (isLinkedInShortUrl(opened.finalUrl)) {
      throw new PlatformInputError(
        'This LinkedIn short link did not resolve to a public destination. It may be expired, blocked, or showing an interstitial. Paste the full public post or destination URL instead.',
        'SHORT_LINK_UNRESOLVED',
      );
    }

    // Reparse to reject credentials/schemes and reclassify the actual destination:
    // lnkd.in may point to another platform or an ordinary public webpage.
    return normalizeInputResult(opened.finalUrl);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error instanceof PlatformInputError) throw error;
    throw new PlatformInputError(
      `The LinkedIn short link could not be resolved safely. ${error?.message || 'The request failed.'} Paste the full public destination URL instead.`,
      'SHORT_LINK_RESOLUTION_FAILED',
    );
  } finally {
    if (typeof opened?.response?.destroy === 'function') opened.response.destroy();
    else if (typeof opened?.response?.resume === 'function') opened.response.resume();
  }
}

module.exports = { PlatformInputError, resolvePlatformInput };

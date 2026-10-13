const { parseHttpUrl } = require('./url-policy');

const LINKEDIN_SHORT_HOSTS = new Set(['lnkd.in', 'www.lnkd.in']);

const PLATFORM_HOSTS = {
  youtube: new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']),
  dailymotion: new Set(['dailymotion.com', 'www.dailymotion.com', 'geo.dailymotion.com', 'dai.ly']),
  linkedin: new Set(['linkedin.com', 'www.linkedin.com', 'm.linkedin.com', ...LINKEDIN_SHORT_HOSTS]),
  instagram: new Set(['instagram.com', 'www.instagram.com']),
};

const SUPPORTED_PLATFORMS = new Set(Object.keys(PLATFORM_HOSTS));
const LINKEDIN_TRACKING_PARAMS = new Set([
  'trk', 'trkemail', 'trackingid', 'trackingurn', 'lipi', 'lici', 'rcm',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
]);

function isLinkedInShortUrl(rawUrl) {
  try {
    const url = parseHttpUrl(rawUrl);
    return LINKEDIN_SHORT_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''));
  } catch {
    return false;
  }
}

function normalizeLinkedInUrl(url) {
  if (isLinkedInShortUrl(url.href)) {
    throw new Error('This LinkedIn short link has not resolved to a public destination. Paste the full public post or destination URL instead.');
  }

  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep malformed escapes unchanged; never guess a different destination.
  }
  pathname = pathname.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (/^\/(?:login(?:-submit)?|logout|authwall|checkpoint|uas|oauth|psignin|signup|registration|reg|onboarding|start\/join)(?:[\/;]|$)/i.test(pathname)) {
    throw new Error('This LinkedIn URL leads to a sign-in or security checkpoint. Paste a public post URL that is accessible without signing in.');
  }
  if (/^\/(?:safety|redir|redirect|error_pages|404|410)(?:[\/;]|$)/i.test(pathname)) {
    throw new Error('This LinkedIn URL leads to an unavailable page or link interstitial. Paste the full public post or destination URL instead.');
  }

  // Remove only known tracking keys. Preserve the exact encoding and order of
  // all remaining query values, including any necessary identifiers/signatures.
  if (url.search) {
    url.search = url.search.slice(1).split('&').filter((parameter) => {
      const key = parameter.split('=', 1)[0];
      try {
        return !LINKEDIN_TRACKING_PARAMS.has(decodeURIComponent(key.replace(/\+/g, ' ')).toLowerCase());
      } catch {
        return true;
      }
    }).join('&');
  }
}

function classifyPlatform(rawUrl) {
  let url;
  try {
    url = parseHttpUrl(rawUrl);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
    if (hosts.has(hostname)) return platform;
  }
  return null;
}

function isSupportedPlatformUrl(rawUrl) {
  return Boolean(classifyPlatform(rawUrl));
}

function isYoutubePlaylistUrl(rawUrl) {
  if (classifyPlatform(rawUrl) !== 'youtube') return false;
  try {
    const url = parseHttpUrl(rawUrl);
    return Boolean(url.searchParams.get('list'));
  } catch {
    return false;
  }
}

function normalizePlatformUrl(rawUrl, { allowPlaylist = false } = {}) {
  const url = parseHttpUrl(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error('Platform video URLs must use HTTPS.');
  }

  const platform = classifyPlatform(url.href);
  if (!platform) {
    throw new Error('Supported sites are YouTube, Dailymotion, LinkedIn, and Instagram.');
  }

  if (platform === 'linkedin') normalizeLinkedInUrl(url);

  if (isYoutubePlaylistUrl(url.href)) {
    if (!allowPlaylist) {
      url.searchParams.delete('list');
      url.searchParams.delete('index');
    }
  } else if (allowPlaylist) {
    throw new Error('Enter a YouTube playlist URL containing a playlist id.');
  }

  url.hash = '';
  return { url, platform, playlist: isYoutubePlaylistUrl(url.href) };
}

function youtubeVideoUrl(id) {
  const value = String(id || '').trim();
  if (!/^[\w-]{6,32}$/.test(value)) return '';
  return `https://www.youtube.com/watch?v=${encodeURIComponent(value)}`;
}

module.exports = {
  PLATFORM_HOSTS,
  SUPPORTED_PLATFORMS,
  classifyPlatform,
  isLinkedInShortUrl,
  isSupportedPlatformUrl,
  isYoutubePlaylistUrl,
  normalizePlatformUrl,
  youtubeVideoUrl,
};

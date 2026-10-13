const { classifyResource } = require('./resource-types');

const RESOURCE_TAGS = new Set(['a', 'audio', 'embed', 'iframe', 'object', 'source', 'video']);

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function readAttributes(raw) {
  const attributes = {};
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;

  while ((match = pattern.exec(raw))) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }

  return attributes;
}

function splitSrcset(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function resolveCandidate(rawValue, pageUrl) {
  const value = decodeHtml(String(rawValue || '').trim());
  if (!value || /^(?:data|blob|javascript|mailto|tel):/i.test(value)) return null;

  try {
    const resolved = new URL(value, pageUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) return null;
    resolved.hash = '';
    return resolved.href;
  } catch {
    return null;
  }
}

function addCandidate(candidates, rawValue, pageUrl, source, label = '', force = false) {
  const url = resolveCandidate(rawValue, pageUrl);
  if (!url) return;

  const kind = classifyResource(url);
  if (!force && !kind) return;

  if (!candidates.has(url)) {
    candidates.set(url, {
      url,
      kind: kind || 'unknown',
      label: String(label || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      source,
    });
  } else {
    const existing = candidates.get(url);
    if (existing.kind === 'unknown' && kind) existing.kind = kind;
  }
}

function discoverResources(html, pageUrl) {
  const page = new URL(pageUrl);
  const candidates = new Map();
  let baseUrl = page.href;

  const baseMatch = String(html).match(/<base\b([^>]*)>/i);
  if (baseMatch) {
    const baseAttributes = readAttributes(baseMatch[1]);
    const resolvedBase = resolveCandidate(baseAttributes.href, page.href);
    if (resolvedBase) baseUrl = resolvedBase;
  }

  const tagPattern = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let match;
  while ((match = tagPattern.exec(String(html)))) {
    const tagName = match[1].toLowerCase();
    if (!RESOURCE_TAGS.has(tagName)) continue;

    const attributes = readAttributes(match[2]);
    const source = tagName === 'a' ? 'link' : tagName;
    const label = attributes.title || attributes['aria-label'] || attributes.download || '';
    const force = tagName !== 'a' || Boolean(attributes.download);

    for (const value of [attributes.href, attributes.src, attributes.data]) {
      addCandidate(candidates, value, baseUrl, source, label, force);
    }

    for (const value of splitSrcset(attributes.srcset)) {
      addCandidate(candidates, value, baseUrl, source, label, true);
    }
  }

  const metaPattern = /<meta\b([^>]*)>/gi;
  while ((match = metaPattern.exec(String(html)))) {
    const attributes = readAttributes(match[1]);
    const property = `${attributes.property || ''} ${attributes.name || ''}`.toLowerCase();
    if (/(?:og:video|og:audio|twitter:player:stream)/.test(property)) {
      addCandidate(candidates, attributes.content, baseUrl, 'metadata', '', true);
    }
  }

  return [...candidates.values()].filter((candidate) => candidate.url !== page.href);
}

module.exports = {
  decodeHtml,
  discoverResources,
  readAttributes,
  resolveCandidate,
  splitSrcset,
};

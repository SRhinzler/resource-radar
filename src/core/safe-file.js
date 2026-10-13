const fs = require('node:fs/promises');
const path = require('node:path');
const { extensionForKind } = require('./resource-types');

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function stripPath(value) {
  return String(value || '').split(/[\\/]/).pop() || '';
}

function safeFileName(value, fallbackBase = 'download', fallbackExtension = '') {
  let name = stripPath(value).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  name = name.replace(/[. ]+$/g, '');
  if (!name) name = fallbackBase;

  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
    name = `${stem}_` + extension;
  }

  if (!path.extname(name) && fallbackExtension) {
    name += fallbackExtension.startsWith('.') ? fallbackExtension : `.${fallbackExtension}`;
  }

  return name.slice(0, 160).replace(/[. ]+$/g, '') || `${fallbackBase}${fallbackExtension}`;
}

function decodeFilename(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function filenameFromContentDisposition(value) {
  const header = String(value || '');
  const encoded = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i);
  if (encoded) return decodeFilename(encoded[1].trim().replace(/^"|"$/g, ''));

  const quoted = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1];

  const plain = header.match(/filename\s*=\s*([^;]+)/i);
  return plain ? plain[1].trim() : '';
}

function filenameFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    return decodeFilename(pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

function suggestedFileName({ url, headers = {}, kind = 'document' }) {
  const headerName = filenameFromContentDisposition(headers['content-disposition']);
  const urlName = filenameFromUrl(url);
  return safeFileName(headerName || urlName, kind === 'video' ? 'video' : 'document', extensionForKind(kind));
}

async function uniqueDestination(downloadDirectory, desiredName) {
  const root = path.resolve(downloadDirectory);
  const original = safeFileName(desiredName);
  const extension = path.extname(original);
  const stem = extension ? original.slice(0, -extension.length) : original;

  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index})`;
    const candidate = path.resolve(root, `${stem}${suffix}${extension}`);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new Error('The destination path is outside the Downloads folder.');
    }

    try {
      await fs.access(candidate);
      continue;
    } catch {
      // The final file is absent; check the temporary reservation too.
    }

    try {
      await fs.access(`${candidate}.part`);
    } catch {
      return candidate;
    }
  }

  throw new Error('Could not find an unused filename in the Downloads folder.');
}

module.exports = {
  filenameFromContentDisposition,
  safeFileName,
  suggestedFileName,
  uniqueDestination,
};

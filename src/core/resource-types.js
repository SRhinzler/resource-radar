const VIDEO_EXTENSIONS = new Set([
  '3gp',
  'avi',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'ogv',
  'webm',
  'wmv',
]);

const DOCUMENT_EXTENSIONS = new Set([
  'csv',
  'doc',
  'docx',
  'epub',
  'key',
  'ods',
  'odt',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'txt',
  'xls',
  'xlsx',
]);

const VIDEO_MIME_PREFIXES = ['video/'];
const DOCUMENT_MIME_TYPES = new Set([
  'application/epub+zip',
  'application/msword',
  'application/pdf',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'text/csv',
  'text/plain',
]);

function extensionFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    const match = pathname.match(/\.([a-z\d]{1,8})$/i);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function normalizeMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function kindFromMime(value) {
  const mime = normalizeMime(value);
  if (VIDEO_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return 'video';
  if (DOCUMENT_MIME_TYPES.has(mime)) return 'document';
  return null;
}

function kindFromUrl(value) {
  const extension = extensionFromUrl(value);
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  return null;
}

function classifyResource(value, contentType = '') {
  return kindFromMime(contentType) || kindFromUrl(value);
}

function extensionForKind(kind) {
  return kind === 'video' ? '.mp4' : '.pdf';
}

function isSupportedDownload(value, contentType = '') {
  return Boolean(classifyResource(value, contentType));
}

module.exports = {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIME_TYPES,
  VIDEO_EXTENSIONS,
  classifyResource,
  extensionForKind,
  extensionFromUrl,
  isSupportedDownload,
  kindFromMime,
  kindFromUrl,
  normalizeMime,
};

const crypto = require('node:crypto');
const { safeFileName } = require('./safe-file');

const GENERIC_PLAYLIST_TITLES = new Set([
  'playlist',
  'youtube playlist',
  'youtube playlist title',
]);

function cleanFolderPart(value) {
  const text = String(value || '').replace(/[\\/]/g, '_');
  return safeFileName(text, '').replace(/[. ]+$/g, '').slice(0, 120);
}

function playlistIdentifier({ id, url } = {}) {
  const directId = cleanFolderPart(id);
  if (directId) return directId.slice(0, 64);

  try {
    const parsed = new URL(String(url || ''));
    const listId = cleanFolderPart(parsed.searchParams.get('list'));
    if (listId) return listId.slice(0, 64);
  } catch {
    // Use a stable URL-derived identifier below when the URL is malformed.
  }

  const source = String(url || 'playlist');
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
}

function derivePlaylistFolderName({ title, id, url } = {}) {
  const safeTitle = cleanFolderPart(title);
  const identifier = playlistIdentifier({ id, url });
  const generic = !safeTitle || GENERIC_PLAYLIST_TITLES.has(safeTitle.toLowerCase());
  const candidate = generic ? `Playlist - ${identifier}` : safeTitle;
  return cleanFolderPart(candidate) || `Playlist - ${identifier}`;
}

module.exports = {
  derivePlaylistFolderName,
  playlistIdentifier,
};

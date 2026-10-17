const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  addDownloadHistory,
  emptyState,
  loadState,
  rememberUrl,
  saveState,
} = require('../src/core/history-store');
const { derivePlaylistFolderName } = require('../src/core/playlist-folder');

test('URL and completed-download history survives a state file round trip', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let state = rememberUrl(emptyState(), 'example.com/guide#section', new Date('2026-01-02T03:04:05.000Z'));
  state = { ...state, theme: 'dark' };
  state = addDownloadHistory(state, {
    id: 'download-1',
    fileName: 'Guide.pdf',
    title: 'Guide',
    path: path.join(directory, 'Guide.pdf'),
    url: 'https://example.com/guide.pdf',
    mode: 'direct',
    completedAt: '2026-01-02T03:05:05.000Z',
  });
  saveState(directory, state);

  const loaded = loadState(directory);
  assert.equal(loaded.error, '');
  assert.equal(loaded.state.theme, 'dark');
  assert.deepEqual(loaded.state.urlHistory[0], {
    url: 'https://example.com/guide',
    visitedAt: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(loaded.state.downloadHistory[0].fileName, 'Guide.pdf');
});

test('remembering a URL moves it to the front without duplicating it', () => {
  let state = rememberUrl(emptyState(), 'https://example.com/first', new Date('2026-01-01T00:00:00.000Z'));
  state = rememberUrl(state, 'https://example.com/second', new Date('2026-01-02T00:00:00.000Z'));
  state = rememberUrl(state, 'https://example.com/first', new Date('2026-01-03T00:00:00.000Z'));

  assert.deepEqual(state.urlHistory.map((entry) => entry.url), [
    'https://example.com/first',
    'https://example.com/second',
  ]);
  assert.equal(state.urlHistory[0].visitedAt, '2026-01-03T00:00:00.000Z');
});

test('playlist folder names use title or URL identifiers and remain Windows-safe', () => {
  assert.equal(
    derivePlaylistFolderName({ title: 'YouTube playlist', url: 'https://www.youtube.com/playlist?list=PL_safe123' }),
    'Playlist - PL_safe123',
  );
  const titled = derivePlaylistFolderName({ title: 'Lessons: week 1 / intro?', id: 'PL_safe123' });
  assert.equal(titled, 'Lessons_ week 1 _ intro_');
  assert.ok(!/[\\/:*?"<>|]/.test(titled));
});

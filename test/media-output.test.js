const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { downloadMedia } = require('../src/core/yt-dlp');
const { findStagedOutput, publishStagedOutput } = require('../src/core/media-output');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-naming-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeDownload({ title = 'Video by theplateindia', data = 'video', printedTitle = title, exitCode = 0, onArgs = () => {} } = {}) {
  return {
    executable: 'fake-yt-dlp',
    spawnImpl: (_executable, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => { child.killed = true; };
      const directory = args.find((arg) => arg.startsWith('home:')).slice(5);
      const template = args[args.indexOf('--output') + 1];
      const name = template.replace('%(title)s', title).replace('%(ext)s', 'mp4');
      const printedName = template.replace('%(title)s', printedTitle).replace('%(ext)s', 'mp4');
      onArgs(args);
      setImmediate(() => {
        fs.writeFileSync(path.join(directory, name), data);
        child.stdout.emit('data', `RR_PROGRESS|500|1000|1024|1|downloading\n${path.join(directory, printedName)}\n`);
        if (exitCode) child.stderr.emit('data', 'Download failed\n');
        child.exitCode = exitCode;
        child.emit('close', exitCode, null);
      });
      return child;
    },
  };
}

test('playlist download creates the supplied Playlist folder with a numbered, ID-free title', async (t) => {
  const root = temporaryDirectory(t);
  const directory = path.join(root, 'Playlist');
  const result = await downloadMedia({
    url: 'https://www.youtube.com/watch?v=abc12345678',
    downloadDirectory: directory,
    order: 2,
    options: fakeDownload({ title: 'Introduction', onArgs: (args) => {
      assert.equal(args[args.indexOf('--output') + 1], '2. %(title)s.%(ext)s');
      assert.ok(args.includes('--no-playlist'));
      assert.ok(!args.some((arg) => /cookies|username|password/.test(arg)));
    } }),
  });
  assert.equal(result.path, path.join(directory, '2. Introduction.mp4'));
  assert.deepEqual(fs.readdirSync(directory), ['2. Introduction.mp4']);
  assert.deepEqual(fs.readdirSync(root), ['Playlist']);
});

test('concurrent equal titles preserve existing videos and publish separate clean filenames', async (t) => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'Video by theplateindia.mp4'), 'existing');
  const results = await Promise.all(['first', 'second'].map((data) => downloadMedia({
    url: 'https://www.instagram.com/reel/C0RLynzyXRX/',
    downloadDirectory: directory,
    options: fakeDownload({ data }),
  })));
  assert.notEqual(results[0].path, results[1].path);
  assert.deepEqual(results.map((result) => result.fileName).sort(), [
    'Video by theplateindia (1).mp4', 'Video by theplateindia (2).mp4',
  ]);
  assert.equal(fs.readFileSync(path.join(directory, 'Video by theplateindia.mp4'), 'utf8'), 'existing');
  assert.equal(fs.readFileSync(results[0].path, 'utf8'), 'first');
  assert.equal(fs.readFileSync(results[1].path, 'utf8'), 'second');
  assert.equal(fs.readdirSync(directory).length, 3);
});

test('Windows-sanitized titles can be found without a trailing media ID', async (t) => {
  const directory = temporaryDirectory(t);
  const result = await downloadMedia({
    url: 'https://www.youtube.com/watch?v=abc12345678', downloadDirectory: directory,
    options: fakeDownload({ title: 'Lesson ｜ Demo', printedTitle: 'Lesson | Demo' }),
  });
  assert.equal(result.fileName, 'Lesson ｜ Demo.mp4');
  assert.deepEqual(fs.readdirSync(directory), ['Lesson ｜ Demo.mp4']);
});

test('staging finder rejects outside files, fragments, sidecars and ambiguous fallback', (t) => {
  const directory = temporaryDirectory(t);
  const staging = path.join(directory, 'staging');
  fs.mkdirSync(staging);
  const external = path.join(directory, 'outside.mp4');
  fs.writeFileSync(external, 'outside');
  for (const name of ['video.mp4.part', 'video.f137.mp4', 'video.frag1.mp4', 'metadata.json', 'empty.mp4']) {
    fs.writeFileSync(path.join(staging, name), name === 'empty.mp4' ? '' : 'data');
  }
  assert.equal(findStagedOutput(external, staging), '');
  fs.writeFileSync(path.join(staging, 'one.mp4'), 'one');
  fs.writeFileSync(path.join(staging, 'two.mp4'), 'two');
  assert.equal(findStagedOutput('missing title.mp4', staging), '');
  assert.equal(findStagedOutput('one.mp4', staging), path.join(staging, 'one.mp4'));
});

test('failed or canceled media downloads clean only their staging files', async (t) => {
  const directory = temporaryDirectory(t);
  const existing = path.join(directory, 'keep.mp4');
  fs.writeFileSync(existing, 'keep');
  await assert.rejects(downloadMedia({
    url: 'https://www.youtube.com/watch?v=abc12345678', downloadDirectory: directory,
    options: fakeDownload({ exitCode: 1 }),
  }), { code: 'PROCESS_EXIT' });
  await assert.rejects(downloadMedia({
    url: 'https://www.youtube.com/watch?v=abc12345678', downloadDirectory: directory,
    signal: AbortSignal.abort(), options: fakeDownload(),
  }), { code: 'ABORT_ERR' });
  assert.deepEqual(fs.readdirSync(directory), ['keep.mp4']);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
});

test('cancellation during publication removes only the newly created destination', async (t) => {
  const directory = temporaryDirectory(t);
  const staging = path.join(directory, 'staging');
  fs.mkdirSync(staging);
  const source = path.join(staging, 'Title.mp4');
  fs.writeFileSync(source, 'new');
  fs.writeFileSync(path.join(directory, 'Title.mp4'), 'existing');
  await assert.rejects(publishStagedOutput(source, staging, directory, () => {
    if (fs.existsSync(path.join(directory, 'Title (1).mp4'))) {
      throw Object.assign(new Error('Canceled'), { code: 'ABORT_ERR' });
    }
  }), { code: 'ABORT_ERR' });
  assert.equal(fs.existsSync(path.join(directory, 'Title (1).mp4')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'Title.mp4'), 'utf8'), 'existing');
});

test('media publication also respects another direct download\'s .part reservation', async (t) => {
  const directory = temporaryDirectory(t);
  const reservation = path.join(directory, 'Video by theplateindia.mp4.part');
  fs.writeFileSync(reservation, 'direct download in progress');
  const result = await downloadMedia({
    url: 'https://www.instagram.com/reel/C0RLynzyXRX/', downloadDirectory: directory,
    options: fakeDownload(),
  });
  assert.equal(result.fileName, 'Video by theplateindia (1).mp4');
  assert.equal(fs.readFileSync(reservation, 'utf8'), 'direct download in progress');
});

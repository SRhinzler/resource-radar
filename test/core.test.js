const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  classifyPlatform,
  isYoutubePlaylistUrl,
  normalizePlatformUrl,
  youtubeVideoUrl,
} = require('../src/core/site-policy');
const { sortOldestFirst } = require('../src/core/playlist-order');
const {
  buildMetadataArgs,
  formatSelector,
  getHelperDirectory,
  findDownloadOutput,
  downloadMedia,
  normalizeFormats,
  normalizeMediaInfo,
  parseProgressLine,
  resolveYtDlp,
  runJson,
} = require('../src/core/yt-dlp');
const { safeFileName } = require('../src/core/safe-file');
const { calculateTransferProgress } = require('../src/core/downloader');

test('platform policy accepts requested hosts but rejects lookalikes', () => {
  assert.equal(classifyPlatform('https://www.youtube.com/watch?v=abc12345678'), 'youtube');
  assert.equal(classifyPlatform('https://www.dailymotion.com/video/x123abc'), 'dailymotion');
  assert.equal(classifyPlatform('https://www.linkedin.com/posts/example'), 'linkedin');
  assert.equal(classifyPlatform('https://www.instagram.com/reel/abc123/'), 'instagram');
  assert.equal(classifyPlatform('https://youtube.com.attacker.example/watch?v=abc12345678'), null);
  assert.equal(classifyPlatform('https://example.com/?next=https://youtube.com'), null);
});

test('youtube playlist links are identified and single-video normalization removes playlist expansion', () => {
  const playlistUrl = 'https://www.youtube.com/playlist?list=PL1234567890';
  assert.equal(isYoutubePlaylistUrl(playlistUrl), true);
  assert.equal(normalizePlatformUrl(playlistUrl, { allowPlaylist: true }).playlist, true);

  const single = normalizePlatformUrl('https://www.youtube.com/watch?v=abc12345678&list=PL1234567890&index=4');
  assert.equal(single.playlist, false);
  assert.equal(single.url.searchParams.has('list'), false);
  assert.equal(single.url.searchParams.has('index'), false);
  assert.equal(youtubeVideoUrl('abc12345678'), 'https://www.youtube.com/watch?v=abc12345678');
});

test('playlist sorting is oldest-first with stable original order for missing dates', () => {
  const result = sortOldestFirst([
    { title: 'new', uploadDate: '20240103', originalIndex: 1 },
    { title: 'unknown-a', uploadDate: '', originalIndex: 2 },
    { title: 'old', uploadDate: '20220101', originalIndex: 3 },
    { title: 'unknown-b', uploadDate: '', originalIndex: 4 },
  ]);
  assert.deepEqual(result.map((item) => item.title), ['old', 'new', 'unknown-a', 'unknown-b']);
});

test('format metadata exposes safe resolution information and excludes audio-only formats', () => {
  const formats = normalizeFormats([
    { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', height: null },
    { format_id: '18', vcodec: 'avc1', acodec: 'mp4a', width: 640, height: 360, ext: 'mp4', tbr: 800 },
    { format_id: '137', vcodec: 'avc1', acodec: 'none', width: 1920, height: 1080, ext: 'mp4', tbr: 4500 },
  ]);
  assert.deepEqual(formats.map((format) => format.id), ['137', '18']);
  assert.deepEqual(normalizeMediaInfo({ id: 'abc123', title: 'Demo', formats: [{ format_id: '137', vcodec: 'avc1', acodec: 'none', height: 1080 }] }, 'https://www.youtube.com/watch?v=abc123'),
    {
      id: 'abc123', url: 'https://www.youtube.com/watch?v=abc123', platform: 'youtube', title: 'Demo', description: '', uploader: '', duration: null, uploadDate: '', timestamp: null, thumbnail: '',
      formats: [{ id: '137', ext: '', width: null, height: 1080, resolution: '?x1080', fps: null, videoCodec: 'avc1', audioCodec: 'none', hasAudio: false, protocol: '', fileSize: null, bitrate: null }],
      resolutions: [1080], extractor: '', isLive: false,
    });
});

test('yt-dlp arguments enforce public, single-video extraction and resolution selection', () => {
  const args = buildMetadataArgs();
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-playlist'));
  assert.ok(!args.includes('--cookies'));
  assert.equal(formatSelector(), 'bv*+ba/b');
  assert.equal(formatSelector(720), 'bv*[height<=720]+ba/b[height<=720]/b[height<=720]');
  assert.deepEqual(parseProgressLine('download:500|1000|2MiB/s|00:03|downloading'), {
    downloadedBytes: 500, totalBytes: 1000, speed: '2MiB/s', eta: '00:03', status: 'downloading', percent: 50,
  });
  assert.deepEqual(parseProgressLine('500|1000|2MiB/s|00:03|downloading'), {
    downloadedBytes: 500, totalBytes: 1000, speed: '2MiB/s', eta: '00:03', status: 'downloading', percent: 50,
  });
  assert.deepEqual(parseProgressLine('RR_PROGRESS|500|1000|2MiB/s|00:03|downloading'), {
    downloadedBytes: 500, totalBytes: 1000, speed: '2MiB/s', eta: '00:03', status: 'downloading', percent: 50,
  });
});

test('yt-dlp download progress parses the progress template emitted by the helper', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-radar-progress-'));
  const outputPath = path.join(directory, 'Demo.mp4');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  let seenArgs = [];
  const progress = [];

  try {
    const result = await downloadMedia({
      url: 'https://www.youtube.com/watch?v=abc12345678',
      downloadDirectory: directory,
      expectedId: 'abc12345678',
      options: {
        executable: 'fake-yt-dlp',
        spawnImpl: (_executable, args) => {
          seenArgs = args;
          const staging = args.find((arg) => arg.startsWith('home:')).slice(5);
          const stagedPath = path.join(staging, 'Demo.mp4');
          fs.writeFileSync(stagedPath, 'video');
          setImmediate(() => {
            child.stdout.emit('data', 'RR_PROGRESS|500|1000|2MiB/s|00:03|downloading\n');
            child.stdout.emit('data', `${stagedPath}\n`);
            child.exitCode = 0;
            child.emit('close', 0, null);
          });
          return child;
        },
      },
      onProgress: (event) => progress.push(event),
    });

    assert.equal(result.path, outputPath);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].downloadedBytes, 500);
    assert.equal(progress[0].totalBytes, 1000);
    assert.equal(progress[0].percent, 50);
    assert.equal(seenArgs[seenArgs.indexOf('--output') + 1], '%(title)s.%(ext)s');
    assert.ok(seenArgs.includes('--windows-filenames'));
    assert.ok(seenArgs.includes('--no-overwrites'));
    assert.deepEqual(fs.readdirSync(directory), ['Demo.mp4']);
    assert.ok(seenArgs.includes('download:RR_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s|%(progress.status)s'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('LinkedIn video formats survive missing codec and resolution metadata', () => {
  const formats = normalizeFormats([
    { format_id: '0', ext: 'mp4', tbr: 300 },
    { format_id: '1', ext: 'mp4', tbr: 800 },
    { format_id: 'audio', ext: 'm4a' },
    { format_id: 'known-audio', ext: 'mp4', vcodec: 'none' },
  ]);
  assert.deepEqual(formats.map((format) => format.id), ['1', '0']);
  assert.equal(formats[0].height, null);
  assert.equal(formats[0].videoCodec, '');
});

test('packaged helper resolution stays inside the installed resources directory', () => {
  const resourcesPath = path.join('C:', 'Program Files', 'Resource Radar', 'resources');
  const helperDirectory = getHelperDirectory({ packaged: true, resourcesPath });
  assert.equal(helperDirectory, path.join(resourcesPath, 'bin'));
  assert.equal(resolveYtDlp({ packaged: true, resourcesPath }), path.join(resourcesPath, 'bin', 'yt-dlp.exe'));

  const args = buildMetadataArgs({ helperDirectory: path.resolve('bin') });
  assert.ok(args.includes('--no-js-runtimes'));
  assert.ok(args.some((arg) => arg.startsWith('deno:')));
});

test('metadata extraction keeps the renderer contract free of signed stream URLs', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  const seen = {};

  const info = {
    id: 'abc123', title: 'Public demo', formats: [{ format_id: '18', vcodec: 'avc1', acodec: 'mp4a', width: 640, height: 360, url: 'https://cdn.example/signed?token=secret' }],
    webpage_url: 'https://www.youtube.com/watch?v=abc123',
  };
  const result = await runJson('https://www.youtube.com/watch?v=abc123', {
    executable: 'fake-yt-dlp',
    spawnImpl: (executable, args) => {
      seen.executable = executable;
      seen.args = args;
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify(info));
        child.stdout.emit('data', '\n');
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  assert.equal(result.formats[0].url.includes('token'), true);
  assert.equal(seen.executable, 'fake-yt-dlp');
  assert.ok(seen.args.includes('--ignore-config'));
  assert.equal(seen.args.at(-1), 'https://www.youtube.com/watch?v=abc123');
});

test('Windows filename sanitization blocks path separators and reserved names', () => {
  assert.equal(safeFileName('../CON: lecture?.mp4'), 'CON_ lecture_.mp4');
  assert.equal(safeFileName('  report.  ', 'download', '.pdf'), 'report.pdf');
});

test('download output detection finds a Windows-sanitized title by media id', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-radar-output-'));
  const actual = path.join(directory, 'Casa Tupka Anthemo ｜ @YoYoHoneySingh [vRjaGgDsWSo].webm');
  fs.writeFileSync(actual, 'video');

  try {
    const printed = path.join(directory, 'Casa Tupka Anthemo | @YoYoHoneySingh [vRjaGgDsWSo].webm');
    assert.equal(findDownloadOutput(`${printed}\n`, directory, 'vRjaGgDsWSo'), actual);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('direct download progress reports raw percentage, speed, and ETA', () => {
  assert.deepEqual(calculateTransferProgress(500, 1000, 2000), {
    receivedBytes: 500,
    expectedBytes: 1000,
    percent: 50,
    speedBytesPerSecond: 250,
    etaSeconds: 2,
  });
});

test('direct download progress remains live when the server omits content length', () => {
  assert.deepEqual(calculateTransferProgress(4096, null, 1000), {
    receivedBytes: 4096,
    expectedBytes: null,
    percent: null,
    speedBytesPerSecond: 4096,
    etaSeconds: null,
  });
});

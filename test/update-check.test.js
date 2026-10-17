const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  checkLatestRelease,
  compareVersions,
  downloadReleaseAsset,
  isAllowedReleaseAssetUrl,
  isValidSemver,
  normalizeReleaseAsset,
  selectWindowsReleaseAsset,
} = require('../src/core/update-check');

const releaseAsset = (overrides = {}) => ({
  name: 'Resource-Radar-Setup-2.1.0.exe',
  state: 'uploaded',
  size: 2048,
  content_type: 'application/octet-stream',
  browser_download_url: 'https://github.com/SRhinzler/resource-radar/releases/download/v2.1.0/Resource-Radar-Setup-2.1.0.exe',
  digest: 'sha256:' + 'a'.repeat(64),
  ...overrides,
});

test('version comparison follows stable semver precedence and accepts v tags', () => {
  assert.equal(compareVersions('v2.0.0', '2.0.1'), -1);
  assert.equal(compareVersions('2.1.0', 'v2.0.0'), 1);
  assert.equal(compareVersions('2.0.0', 'v2.0.0'), 0);
  assert.equal(compareVersions('2.0.0-beta.2', '2.0.0-beta.11'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0-rc.1'), 1);
  assert.equal(isValidSemver('2.0.0'), true);
  assert.equal(isValidSemver('v2.0'), true);
  assert.equal(compareVersions('v1', '1.0.0'), 0);
  assert.equal(compareVersions('v2.1', '2.0.9'), 1);
  assert.equal(compareVersions('v2', '2.0.0'), 0);
  assert.equal(isValidSemver('v02'), false);
  assert.equal(isValidSemver('release-next'), false);
  assert.equal(isValidSemver('2.01.0'), false);
});

test('release asset selection rejects untrusted URLs and chooses a safe Windows installer', () => {
  const selected = selectWindowsReleaseAsset([
    { ...releaseAsset(), name: 'notes.exe', browser_download_url: 'https://evil.example/notes.exe' },
    releaseAsset({ name: 'Resource-Radar-Setup-2.1.0.exe' }),
    { ...releaseAsset(), name: 'Resource-Radar-Setup-2.1.0.zip' },
  ]);
  assert.equal(selected.name, 'Resource-Radar-Setup-2.1.0.exe');
  assert.equal(selected.digest, `sha256:${'a'.repeat(64)}`);
  assert.equal(isAllowedReleaseAssetUrl(selected.url), true);
  assert.equal(isAllowedReleaseAssetUrl('http://github.com/SRhinzler/resource-radar/releases/download/v2.1.0/setup.exe'), false);
  assert.equal(isAllowedReleaseAssetUrl('https://github.com/other/project/releases/download/v2.1.0/setup.exe'), false);
  assert.equal(isAllowedReleaseAssetUrl('https://objects.githubusercontent.com/github-production-release-asset-1/setup.exe'), true);
  assert.equal(isAllowedReleaseAssetUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/setup.exe?download=1'), true);
  assert.equal(isAllowedReleaseAssetUrl('https://release-assets.githubusercontent.com.evil.example/setup.exe'), false);
});

test('latest release check ignores drafts and prereleases and only reports a newer stable release', async () => {
  const result = await checkLatestRelease('2.0.0', {
    releases: [
      { tag_name: 'v3.0.0-rc.1', prerelease: true, draft: false, assets: [releaseAsset()] },
      { tag_name: 'v2.2.0', prerelease: false, draft: true, assets: [releaseAsset()] },
      { tag_name: 'v2.1.0', prerelease: false, draft: false, name: 'A safer release', body: '<script>alert(1)</script>', assets: [releaseAsset()] },
    ],
  });

  assert.equal(result.status, 'available');
  assert.equal(result.latestVersion, '2.1.0');
  assert.equal(result.release.title, 'A safer release');
  assert.equal(result.release.asset.name, 'Resource-Radar-Setup-2.1.0.exe');

  const current = await checkLatestRelease('2.1.0', { releases: [{ tag_name: 'v2.1.0', prerelease: false, draft: false, assets: [releaseAsset()] }] });
  assert.equal(current.status, 'up-to-date');
});

test('published short v1/v2 tags compare without attempting a downgrade', async () => {
  for (const tag of ['v1', 'v2', 'v2.0']) {
    const result = await checkLatestRelease('2.0.0', { releases: [{ tag_name: tag, draft: false, prerelease: false }] });
    assert.equal(result.status, 'up-to-date');
  }
});

test('asset selection is bound to the checked release and uploaded asset name', () => {
  const url = releaseAsset().browser_download_url;
  for (const changes of [
    { state: 'starter' }, { name: 'other.exe' }, { size: 0 }, { size: 501 * 1024 * 1024 },
    { digest: 'sha256:bad' }, { content_type: 'text/html' },
    { browser_download_url: url.replace('/v2.1.0/', '/v3/') },
    { browser_download_url: url + '?token=example' }, { browser_download_url: url + '#fragment' },
    { browser_download_url: url.replace('github.com/', 'github.com:444/') },
    { browser_download_url: url.replace('github.com/', 'user@github.com/') },
    { browser_download_url: url.replace('github.com/', 'release-assets.githubusercontent.com/') },
  ]) {
    assert.throws(() => selectWindowsReleaseAsset([releaseAsset(changes)], 'v2.1.0'), { code: 'NO_WINDOWS_ASSET' });
  }
  assert.equal(selectWindowsReleaseAsset([releaseAsset()], 'v2.1.0').tagName, 'v2.1.0');
});

function downloadFixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('MZ-test-only-installer-not-executable');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const asset = normalizeReleaseAsset(releaseAsset({ size: bytes.length, digest: `sha256:${digest}`, ...changes }), 'v2.1.0');
  return { bytes, digest, asset, destination: path.join(root, asset.name) };
}

function fakeResponse(bytes, overrides = {}) {
  const response = Readable.from([bytes]);
  response.headers = { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), ...overrides.headers };
  if (overrides.complete !== undefined) response.complete = overrides.complete;
  return { response, statusCode: overrides.statusCode || 200 };
}

test('update streaming verifies exact bytes and digest before returning an installer', async (t) => {
  const fixture = downloadFixture(t);
  const progress = [];
  const result = await downloadReleaseAsset(fixture.asset, fixture.destination, {
    requestResponse: async (url) => {
      assert.equal(url, fixture.asset.url);
      return fakeResponse(fixture.bytes);
    },
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.digestVerified, true);
  assert.equal(result.sha256, fixture.digest);
  assert.deepEqual(fs.readFileSync(fixture.destination), fixture.bytes);
  assert.equal(progress.at(-1).percent, 100);
});

test('missing optional digest is not reported as hash verification', async (t) => {
  const fixture = downloadFixture(t, { digest: null });
  const result = await downloadReleaseAsset(fixture.asset, fixture.destination, {
    requestResponse: async () => fakeResponse(fixture.bytes),
  });
  assert.equal(result.digestVerified, false);
});

test('broken update responses never leave an installer ready to launch', async (t) => {
  for (const failure of ['digest', 'short', 'oversize', 'length', 'incomplete', 'html', 'http', 'interrupted']) {
    await t.test(failure, async (t) => {
      const fixture = downloadFixture(t);
      let bytes = fixture.bytes;
      const overrides = {};
      if (failure === 'digest') bytes = Buffer.alloc(bytes.length, 65);
      if (failure === 'short') { bytes = bytes.subarray(0, 10); overrides.headers = { 'content-length': undefined }; }
      if (failure === 'oversize') { bytes = Buffer.concat([bytes, Buffer.from('extra')]); overrides.headers = { 'content-length': undefined }; }
      if (failure === 'length') overrides.headers = { 'content-length': '999' };
      if (failure === 'incomplete') overrides.complete = false;
      if (failure === 'html') overrides.headers = { 'content-type': 'text/html' };
      if (failure === 'http') overrides.statusCode = 403;
      const opened = fakeResponse(bytes, overrides);
      if (failure === 'interrupted') {
        opened.response = new Readable({ read() { this.destroy(new Error('interrupted test response')); } });
        opened.response.headers = {};
      }
      await assert.rejects(downloadReleaseAsset(fixture.asset, fixture.destination, { requestResponse: async () => opened }));
      assert.equal(fs.existsSync(fixture.destination), false);
      assert.equal(opened.response.destroyed, true);
    });
  }
});

test('failed exclusive reservation never removes a pre-existing file or fetches bytes', async (t) => {
  const fixture = downloadFixture(t);
  fs.writeFileSync(fixture.destination, 'keep existing data');
  let requested = false;
  await assert.rejects(downloadReleaseAsset(fixture.asset, fixture.destination, {
    requestResponse: async () => { requested = true; return fakeResponse(fixture.bytes); },
  }));
  assert.equal(requested, false);
  assert.equal(fs.readFileSync(fixture.destination, 'utf8'), 'keep existing data');
});

test('update downloader validates URLs even with trusted request injection and rejects cancellation', async (t) => {
  const fixture = downloadFixture(t);
  const requestResponse = async () => { throw new Error('must not fetch'); };
  await assert.rejects(downloadReleaseAsset({ ...fixture.asset, url: 'https://evil.example/installer.exe' }, fixture.destination, { requestResponse }), { code: 'INVALID_UPDATE_URL' });
  await assert.rejects(downloadReleaseAsset(fixture.asset, fixture.destination, { requestResponse, signal: AbortSignal.abort() }), { code: 'ABORTED' });
  assert.equal(fs.existsSync(fixture.destination), false);
});

function githubTransportFixture(t, bytes, mixedPrivateDns = false) {
  const dnsCalls = [];
  const requestHosts = [];
  const addresses = [
    { address: '64:ff9b::b9c7:6d85', family: 6 },
    { address: '185.199.109.133', family: 4 },
  ];
  t.mock.method(require('node:dns').promises, 'lookup', async (host) => {
    dnsCalls.push(host);
    return mixedPrivateDns && host === 'release-assets.githubusercontent.com'
      ? [...addresses, { address: '127.0.0.1', family: 4 }] : addresses;
  });
  t.mock.method(require('node:https'), 'request', (options, onResponse) => {
    requestHosts.push(options.hostname);
    const request = new EventEmitter();
    request.destroy = (error) => { queueMicrotask(() => request.emit('error', error)); return request; };
    request.end = () => queueMicrotask(() => {
      options.lookup(options.hostname, { all: true }, (error, candidates) => {
        // Model an unavailable IPv6 route: the transport needs a vetted IPv4
        // candidate and family fallback, without performing another DNS lookup.
        if (error || !options.autoSelectFamily || !Array.isArray(candidates)
          || !candidates.some((record) => record.family === 4)) {
          request.destroy(error || new Error('No fallback from unavailable IPv6 route'));
          return;
        }
        const opened = fakeResponse(bytes);
        opened.response.statusCode = 200;
        if (options.hostname === 'github.com') {
          opened.response.statusCode = 302;
          opened.response.headers.location = 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture/setup.exe';
        }
        onResponse(opened.response);
      });
    });
    return request;
  });
  return { dnsCalls, requestHosts };
}

test('GitHub redirects retain vetted dual-stack addresses for transport fallback', async (t) => {
  const fixture = downloadFixture(t);
  const transport = githubTransportFixture(t, fixture.bytes);
  const result = await downloadReleaseAsset(fixture.asset, fixture.destination);
  assert.equal(result.digestVerified, true);
  assert.deepEqual(fs.readFileSync(fixture.destination), fixture.bytes);
  assert.deepEqual(transport.dnsCalls, ['github.com', 'release-assets.githubusercontent.com']);
  assert.deepEqual(transport.requestHosts, transport.dnsCalls, 'one DNS validation before each redirect hop');
});

test('GitHub redirect rejects mixed public/private DNS before requesting CDN bytes', async (t) => {
  const fixture = downloadFixture(t);
  const transport = githubTransportFixture(t, fixture.bytes, true);
  await assert.rejects(downloadReleaseAsset(fixture.asset, fixture.destination), /private or local/);
  assert.deepEqual(transport.requestHosts, ['github.com']);
  assert.equal(fs.existsSync(fixture.destination), false);
});

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dns = require('node:dns').promises;
const https = require('node:https');
const test = require('node:test');
const { resolvePlatformInput } = require('../src/core/platform-input');
const { classifyPlatform, normalizePlatformUrl } = require('../src/core/site-policy');

const shortUrl = 'https://lnkd.in/p/example';
const postUrl = 'https://www.linkedin.com/posts/example-video-activity-1234567890123456789-abcd/';

test('LinkedIn short-link hosts are exact matches, not substring matches', () => {
  for (const host of ['lnkd.in', 'www.lnkd.in', 'linkedin.com', 'www.linkedin.com']) {
    assert.equal(classifyPlatform(`https://${host}/p/example`), 'linkedin');
  }
  for (const host of ['lnkd.in.example.com', 'linkedin.com.attacker.example', 'untrusted.lnkd.in']) {
    assert.equal(classifyPlatform(`https://${host}/p/example`), null);
  }
  assert.throws(() => normalizePlatformUrl(shortUrl), /not resolved/);
});

test('short links resolve before extraction and remove LinkedIn referral tracking', async () => {
  let disposed = false;
  const result = await resolvePlatformInput(shortUrl, {
    openPublicResponseImpl: async (url, options) => {
      assert.equal(url, shortUrl);
      assert.equal(options.maxRedirects, 5);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Cookie, undefined);
      return {
        statusCode: 200,
        finalUrl: `${postUrl}?utm_source=share&rcm=example&keep=one%2Btwo`,
        response: { destroy: () => { disposed = true; } },
      };
    },
  });
  assert.deepEqual(result, { url: `${postUrl}?keep=one%2Btwo`, platform: 'linkedin', playlist: false });
  assert.equal(disposed, true);
});

test('ordinary platform inputs do not request redirects and keep YouTube course playlist IDs', async () => {
  const openPublicResponseImpl = () => { throw new Error('Unexpected network'); };
  const course = 'https://www.youtube.com/playlist?list=PLcourse123';
  assert.deepEqual(await resolvePlatformInput(course, { openPublicResponseImpl }), {
    url: course, platform: 'youtube', playlist: true,
  });
  assert.equal((await resolvePlatformInput(postUrl, { openPublicResponseImpl })).url, postUrl);
});

test('short-link destinations are reclassified instead of always assuming LinkedIn', async () => {
  for (const [url, platform, playlist] of [
    ['https://www.youtube.com/playlist?list=PLcourse123', 'youtube', true],
    ['https://example.com/resources', null, false],
  ]) {
    const result = await resolvePlatformInput(shortUrl, {
      openPublicResponseImpl: async () => ({ statusCode: 200, finalUrl: url, response: { destroy() {} } }),
    });
    assert.deepEqual(result, { url, platform, playlist });
  }
});

test('expired, blocked, login and unresolved LinkedIn links return actionable errors and close responses', async () => {
  for (const [statusCode, finalUrl, message] of [
    [404, shortUrl, /expired/], [403, postUrl, /blocked|sign-in/],
    [200, shortUrl, /did not resolve/], [200, 'https://www.linkedin.com/authwall', /sign-in/],
    [200, 'https://www.linkedin.com/checkpoint/challenge', /checkpoint/],
    [200, 'https://name:password@www.linkedin.com/posts/example', /credentials/],
  ]) {
    let disposed = false;
    await assert.rejects(resolvePlatformInput(shortUrl, {
      openPublicResponseImpl: async () => ({ statusCode, finalUrl, response: { destroy: () => { disposed = true; } } }),
    }), message);
    assert.equal(disposed, true);
  }
  await assert.rejects(resolvePlatformInput('http://lnkd.in/example'), /HTTPS/);
});

test('default short-link opener rejects private addresses on every redirect hop', async (t) => {
  const hosts = [];
  const requests = [];
  let redirectedResponseDisposed = false;
  t.mock.method(dns, 'lookup', async (hostname) => {
    hosts.push(hostname);
    return [{ address: hostname === 'lnkd.in' ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  });
  t.mock.method(https, 'request', (options, onResponse) => {
    requests.push(options);
    const request = new EventEmitter();
    request.end = () => setImmediate(() => onResponse({
      statusCode: 302, headers: { location: 'https://internal.example/secret' },
      resume: () => { redirectedResponseDisposed = true; },
    }));
    return request;
  });
  await assert.rejects(resolvePlatformInput(shortUrl), /private or local network/);
  assert.deepEqual(hosts, ['lnkd.in', 'internal.example']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, '8.8.8.8');
  assert.equal(redirectedResponseDisposed, true);
});

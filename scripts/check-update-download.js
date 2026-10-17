// Optional online transport check. Downloads the published Windows installer to
// disposable staging and verifies its digest; NEVER opens or installs the file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkLatestRelease, downloadReleaseAsset } = require('../src/core/update-check');

async function run() {
  const parent = process.argv[2];
  if (!parent || !fs.statSync(parent).isDirectory()) throw new Error('Pass an existing temporary directory.');
  const directory = fs.mkdtempSync(path.join(parent, 'radar-github-download-check-'));
  try {
    // A fixture installed version exercises the current public asset, including v1.
    const result = await checkLatestRelease('0.0.0');
    assert.equal(result.status, 'available', result.error);
    assert.ok(result.release.asset.digest, 'This online check requires a GitHub SHA-256 digest.');
    console.log(`Checking release transport for ${result.release.tagName}: ${result.release.asset.name}`);
    let last = -1;
    const file = await downloadReleaseAsset(result.release.asset, path.join(directory, result.release.asset.name), {
      onProgress: ({ percent }) => {
        const step = Math.floor(percent / 25);
        if (step !== last) { last = step; console.log(`Release installer download: ${step * 25}%`); }
      },
    });
    assert.equal(file.digestVerified, true);
    console.log(JSON.stringify({ tag: result.release.tagName, asset: result.release.asset.name,
      bytes: file.size, sha256: file.sha256, digestVerified: true, installerLaunched: false }));
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });

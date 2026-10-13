const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const helperDirectory = path.join(projectRoot, 'bin');
const manifestPath = path.join(helperDirectory, 'manifest.json');

function fail(message) {
  console.error(`Media tool bundle check failed: ${message}`);
  process.exitCode = 1;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(manifestPath)) {
  fail(`missing ${path.relative(projectRoot, manifestPath)}`);
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = [manifest.ytDlp, manifest.ffmpeg, manifest.ffprobe, manifest.deno];

  for (const entry of entries) {
    if (!entry?.file || !entry.sha256) {
      fail('manifest has an incomplete tool entry');
      continue;
    }

    const filePath = path.join(helperDirectory, entry.file);
    if (!fs.existsSync(filePath)) {
      fail(`missing ${path.relative(projectRoot, filePath)}`);
      continue;
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < 1024) {
      fail(`${entry.file} is empty or is not a regular file`);
      continue;
    }

    const actualHash = sha256(filePath);
    if (actualHash !== entry.sha256.toLowerCase()) {
      fail(`${entry.file} checksum mismatch (expected ${entry.sha256}, got ${actualHash})`);
      continue;
    }

    console.log(`${entry.file} ${entry.version} verified`);
  }

  const noticePath = path.join(helperDirectory, 'THIRD_PARTY_NOTICES.md');
  if (!fs.existsSync(noticePath)) fail('missing bin/THIRD_PARTY_NOTICES.md');
}

if (process.exitCode) process.exit(process.exitCode);

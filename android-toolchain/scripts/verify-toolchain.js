const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'toolchain-manifest.json');
const sourceVerifierPath = path.join(root, 'termux', 'verify-sources.sh');
const installerPath = path.join(root, 'termux', 'install-media-tools.sh');
const errors = [];

function fail(message) {
  errors.push(message);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(candidate));
    else files.push(candidate);
  }
  return files;
}

if (!fs.existsSync(manifestPath)) {
  fail('toolchain-manifest.json is missing');
} else {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error.message}`);
  }

  if (manifest) {
    if (manifest.schema !== 1) fail('manifest schema must be 1');
    if (manifest.platform !== 'android') fail('manifest platform must be android');
    if (manifest.status !== 'termux-runtime-scaffold-not-release') fail('manifest status is unexpected');
    if (manifest.binariesCheckedIn !== false) fail('binariesCheckedIn must remain false');

    const expectedAbis = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
    if (JSON.stringify(manifest.target?.abis) !== JSON.stringify(expectedAbis)) {
      fail(`target ABIs must be ${expectedAbis.join(', ')}`);
    }

    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
      fail('manifest must contain artifacts');
    } else {
      const sourceVerifier = fs.existsSync(sourceVerifierPath)
        ? fs.readFileSync(sourceVerifierPath, 'utf8')
        : '';
      const installer = fs.existsSync(installerPath)
        ? fs.readFileSync(installerPath, 'utf8')
        : '';
      if (!sourceVerifier) fail('termux/verify-sources.sh is missing');
      if (!installer) fail('termux/install-media-tools.sh is missing');

      for (const artifact of manifest.artifacts) {
        if (!artifact?.name || !artifact?.status) fail('every artifact needs a name and status');
        if (artifact?.sourceUrl && !/^https:\/\//i.test(artifact.sourceUrl)) {
          fail(`${artifact.name || 'artifact'} sourceUrl must use HTTPS`);
        }
        if (artifact?.buildRecipeUrl && !/^https:\/\//i.test(artifact.buildRecipeUrl)) {
          fail(`${artifact.name || 'artifact'} buildRecipeUrl must use HTTPS`);
        }
        if (artifact.status !== 'blocked-no-official-android-artifact' && !isSha256(artifact.sourceSha256)) {
          fail(`${artifact.name || 'artifact'} needs a 64-character sourceSha256`);
        }
        if (artifact.status !== 'blocked-no-official-android-artifact' && artifact.sourceSha256
          && !sourceVerifier.includes(artifact.sourceSha256)) {
          fail(`${artifact.name || 'artifact'} sourceSha256 is not checked by verify-sources.sh`);
        }
        if (['yt-dlp', 'python', 'ffmpeg', 'node'].includes(artifact.name)
          && artifact.version && !installer.includes(artifact.version)) {
          fail(`${artifact.name} version is not pinned by install-media-tools.sh`);
        }
      }
    }
  }
}

for (const filePath of walk(root)) {
  if (/\.(?:apk|a|dylib|dll|exe|so|zip)$/i.test(filePath)) {
    fail(`native/binary artifact is not allowed in android-toolchain: ${path.relative(root, filePath)}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`Android toolchain check failed: ${error}`);
  process.exitCode = 1;
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`Android toolchain metadata verified: ${manifest.artifacts.length} artifacts, no binaries`);
}

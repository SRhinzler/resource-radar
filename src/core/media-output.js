const fs = require('node:fs');
const path = require('node:path');

const VIDEO_EXTENSIONS = new Set([
  '.3g2', '.3gp', '.asf', '.avi', '.divx', '.f4v', '.flv', '.m2ts', '.m4v', '.mkv',
  '.mov', '.mp4', '.mpe', '.mpeg', '.mpg', '.mts', '.mxf', '.ogm', '.ogv', '.qt',
  '.rm', '.rmvb', '.ts', '.vob', '.webm', '.wmv',
]);

function isCompletedMediaFile(candidate, stagingDirectory) {
  const root = path.resolve(stagingDirectory);
  const target = path.resolve(candidate);
  // The output template is flat. Do not follow subdirectories or their links.
  if (path.relative(root, path.dirname(target)) !== '') return false;
  const name = path.basename(target);
  if (!VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) return false;
  if (/\.(?:part|ytdl|tmp|temp)(?:$|[.-])|[.-]frag\d+(?:$|[.-])|\.f\d+(?:[-_][^.]+)?\.[^.]+$/i.test(name)) return false;

  try {
    const directory = fs.lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    const file = fs.lstatSync(target);
    return file.isFile() && !file.isSymbolicLink() && file.size > 0;
  } catch {
    return false;
  }
}

function findStagedOutput(stdout, stagingDirectory) {
  const root = path.resolve(stagingDirectory);
  let entries;
  try {
    const directory = fs.lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return '';
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }

  const completed = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(root, entry.name))
    .filter((candidate) => isCompletedMediaFile(candidate, root));
  const lines = String(stdout || '')
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/^\uFEFF/, '').replace(/[\u001b\u009b]\[[0-?]*[ -/]*[@-~]/g, '').trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    const candidate = path.resolve(root, line);
    const match = completed.find((file) => path.relative(candidate, file) === '');
    if (match) return match;
  }

  // Windows may sanitize the title differently from the printed filepath.
  // Only this download's isolated, unambiguous completed file is a fallback.
  return completed.length === 1 ? completed[0] : '';
}

async function publishStagedOutput(stagedPath, stagingDirectory, downloadDirectory, checkCanceled = () => {}) {
  if (!isCompletedMediaFile(stagedPath, stagingDirectory)) {
    const error = new Error('The completed video is missing or is not a regular file in its staging folder.');
    error.code = 'MISSING_OUTPUT';
    throw error;
  }

  const root = path.resolve(downloadDirectory);
  const name = path.basename(stagedPath);
  const extension = path.extname(name);
  const stem = name.slice(0, -extension.length);

  for (let index = 0; index < 10_000; index += 1) {
    checkCanceled();
    const suffix = index === 0 ? '' : ` (${index})`;
    const destination = path.join(root, `${stem}${suffix}${extension}`);
    const reservationPath = `${destination}.part`;
    let reservation;
    try {
      // Share the direct downloader's reservation convention too: otherwise its
      // in-flight .part file could later be renamed over this published video.
      reservation = await fs.promises.open(reservationPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }

    try {
      checkCanceled();
      try {
        await fs.promises.copyFile(stagedPath, destination, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      try {
        checkCanceled();
      } catch (error) {
        // The exclusive copy succeeded, so only this operation owns this file.
        await fs.promises.unlink(destination);
        throw error;
      }
      return destination;
    } finally {
      await reservation.close();
      await fs.promises.unlink(reservationPath);
    }
  }

  const error = new Error('Could not find an unused filename in the Downloads folder.');
  error.code = 'DESTINATION_COLLISION';
  throw error;
}

module.exports = {
  findStagedOutput,
  publishStagedOutput,
};

// Run with JDK 17+ on PATH; no Android device, Gradle dependencies or network required.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const parent = process.argv[2] || os.tmpdir();
if (!fs.statSync(parent).isDirectory()) throw new Error('Pass an existing temporary directory.');
const output = fs.mkdtempSync(path.join(parent, 'radar-update-policy-'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
try {
  run('javac', ['-encoding', 'UTF-8', '-d', output,
    'android/app/src/main/java/com/rhinzler/resourceradar/UpdatePolicy.java',
    'android/tests/UpdatePolicyTest.java']);
  run('java', ['-cp', output, 'com.rhinzler.resourceradar.UpdatePolicyTest']);
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}

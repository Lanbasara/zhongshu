// Run only inside a disposable workspace. A bounded native-tool observation aid.
import { writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const marker = process.argv[2];
if (process.argv.length !== 3 || !/^[a-z0-9]{8,40}$/.test(marker ?? '')) throw new Error('pass_one_lowercase_alphanumeric_marker_8_to_40_chars');
const started = `gate-${marker}.started.json`;
const release = `gate-${marker}.release`;
const finished = `gate-${marker}.finished.json`;
await writeFile(started, JSON.stringify({ pid: process.pid, cwd: process.cwd(), marker, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
let outcome = 'timeout';
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  try { await access(release); outcome = 'released'; break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await delay(100);
}
await writeFile(finished, JSON.stringify({ pid: process.pid, marker, outcome, finishedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
console.log(`GATE ${marker} ${outcome}`);
if (outcome !== 'released') process.exitCode = 1;

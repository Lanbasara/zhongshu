import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--watch', 'src/server/main.ts'], { stdio: 'inherit', env: { ...process.env, PORT: '3001', ZHONGSHU_ORIGIN: 'http://127.0.0.1:3000', ZHONGSHU_ALLOW_HTTP_LOOPBACK: 'true' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); }
for (const child of children) { child.once('error', stop); child.once('exit', (code) => { if (!stopping) { process.exitCode = code ?? 1; stop(); } }); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);

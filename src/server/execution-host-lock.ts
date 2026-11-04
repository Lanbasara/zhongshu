import { spawn } from 'node:child_process';
import { constants, fstatSync, lstatSync } from 'node:fs';
import { lstat, open, realpath, statfs } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { ExecutionHostError } from './execution-host-docker.ts';

/** Linux flock is attached to the shared open-file description. The fixed
 * helper locks inherited fd 3 then exits; the parent retains that description.
 * A helper/worker exit cannot release it. No TTL, PID-file stealing or unlink.
 * This remains exclusive across gateway network/PID/container namespaces. */
export async function acquireExecutionFileLock(path: string) {
  if (process.platform !== 'linux' || !isAbsolute(path)) throw new ExecutionHostError('execution_linux_owner_lock_required');
  const parent = await realpath(dirname(path)); const directory = await lstat(parent);
  if (parent !== dirname(path) || !directory.isDirectory() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new ExecutionHostError('execution_owner_directory_unsafe');
  const filesystem = await statfs(parent);
  if (![0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x794c7630].includes(filesystem.type)) throw new ExecutionHostError('execution_local_owner_filesystem_required');
  const executable = await lstat('/usr/bin/flock');
  if (!executable.isFile() || executable.isSymbolicLink() || executable.uid !== 0 || executable.mode & 0o022 || !(executable.mode & 0o111)) throw new ExecutionHostError('execution_flock_unavailable');
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  try {
    const identity = await file.stat();
    if (!identity.isFile() || identity.nlink !== 1 || identity.mode & 0o077 || process.getuid && identity.uid !== process.getuid()) throw new ExecutionHostError('execution_owner_file_unsafe');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { shell: false, env: {}, stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('error', () => { clearTimeout(timer); reject(new ExecutionHostError('execution_flock_unavailable')); });
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new ExecutionHostError('execution_host_owned')); });
    });
    return { assertOwned() {
      if (closed || file.fd < 0) throw new ExecutionHostError('execution_host_ownership_lost');
      const current = lstatSync(path); const held = fstatSync(file.fd);
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino || held.dev !== identity.dev || held.ino !== identity.ino || current.nlink !== 1) throw new ExecutionHostError('execution_host_ownership_lost');
    }, async close() { if (!closed) { closed = true; await file.close(); } } };
  } catch (error) { await file.close(); throw error; }
}

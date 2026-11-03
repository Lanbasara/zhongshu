import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { z } from 'zod';

export type HostPhase = 'online' | 'paused' | 'unknown';
export type MaintenanceController = (action: 'status' | 'pause' | 'resume') => Promise<HostPhase>;
const response = z.object({ state: z.enum(['online', 'paused']) }).strict();
const execute = promisify(execFile);

// The operator supplies one executable bound to one dedicated Host. Browser input
// never becomes a command, argument, environment variable or filesystem path here.
export function maintenanceController(file: string): MaintenanceController {
  return async action => {
    try {
      const info = await lstat(file);
      if (!info.isFile() || await realpath(file) !== file || !(info.mode & 0o100) ||
        (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) return 'unknown';
      const { stdout } = await execute(file, [action], { timeout: action === 'status' ? 15_000 : 90_000, maxBuffer: 4096,
        env: { PATH: '/usr/bin:/bin:/usr/local/bin' } });
      return response.parse(JSON.parse(stdout)).state;
    } catch { return 'unknown'; }
  };
}

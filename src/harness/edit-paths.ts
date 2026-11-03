import { posix } from 'node:path';
import { recordedFilePath } from '../shared/content.ts';

/** The native producer supplies the resolved target in its execution filesystem. */
export function editPath(cwd: string, nativePath: unknown): string | undefined {
  if (typeof nativePath !== 'string' || nativePath.length > 4096 || !posix.isAbsolute(nativePath)
    || posix.normalize(nativePath) !== nativePath) return;
  const path = recordedFilePath.safeParse(posix.relative(cwd, nativePath));
  if (path.success) return path.data;
}

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AuthError, createAuth } from './auth.ts';
import { DatabaseError, backupDatabase, openDatabase, restoreDatabase } from './database.ts';
import { afterProductRestore, productMigrations } from './migrations.ts';

async function stdinPassword(): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of process.stdin) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += bytes.length;
      if (size > 1026) throw new AuthError('password_input_too_large');
      parts.push(bytes);
    }
    // Strip one line ending added by a password manager or a shell pipeline, not whitespace.
    return Buffer.concat(parts).toString('utf8').replace(/\r?\n$/, '');
  } finally { for (const part of parts) part.fill(0); }
}

async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AuthError('interactive_terminal_required_or_use_password_stdin');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  input.on('SIGINT', interrupt);
  try {
    process.stdout.write('New administrator password (at least 12 characters): ');
    const first = await input.question('', { signal: controller.signal });
    if (Buffer.byteLength(first) > 1024) throw new AuthError('password_input_too_large');
    process.stdout.write('\nConfirm password: ');
    const second = await input.question('', { signal: controller.signal });
    process.stdout.write('\n');
    if (first !== second) throw new AuthError('password_confirmation_mismatch');
    return first;
  } finally { input.close(); muted.destroy(); }
}

export async function runAdmin(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options: { 'data-dir': { type: 'string' }, 'password-stdin': { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  } catch { throw new AuthError('invalid_arguments'); }
  if (parsed.values.help) {
    process.stdout.write('Usage: admin <init|reset> [--data-dir DIRECTORY] [--password-stdin]\n       admin <backup|restore> FILE [--data-dir DIRECTORY]\nData directory: --data-dir, ZHONGSHU_DATA_DIR, or ~/.local/share/zhongshu.\nRestore requires a fresh target and revokes restored sessions.\n');
    return;
  }
  const command = z.enum(['init', 'reset', 'backup', 'restore']).safeParse(parsed.positionals[0]);
  if (!command.success) throw new AuthError('invalid_arguments');
  const needsFile = command.data === 'backup' || command.data === 'restore';
  if (parsed.positionals.length !== (needsFile ? 2 : 1) || (needsFile && parsed.values['password-stdin'])) throw new AuthError('invalid_arguments');
  const directoryValue = parsed.values['data-dir'] ?? process.env.ZHONGSHU_DATA_DIR ?? join(homedir(), '.local/share/zhongshu');
  const directory = z.string().min(1).max(4096).safeParse(directoryValue);
  if (!directory.success) throw new AuthError('invalid_data_directory');
  if (command.data === 'restore') {
    await restoreDatabase(parsed.positionals[1]!, directory.data, afterProductRestore);
    process.stdout.write('Database restored; sessions are revoked and pending operations require reconciliation.\n');
    return;
  }
  const db = openDatabase(directory.data, productMigrations);
  try {
    if (command.data === 'backup') {
      await backupDatabase(db, parsed.positionals[1]!);
      process.stdout.write('Database backup completed and verified.\n');
    } else {
      const auth = createAuth(db);
      // Reject mistaken init/reset before prompting for a secret.
      if (command.data === 'init' && auth.initialized()) throw new AuthError('admin_already_initialized');
      if (command.data === 'reset' && !auth.initialized()) throw new AuthError('admin_not_initialized');
      const password = parsed.values['password-stdin'] ? await stdinPassword() : await promptPassword();
      if (command.data === 'init') await auth.initialize(password); else await auth.reset(password);
      process.stdout.write(command.data === 'init' ? 'Administrator initialized.\n' : 'Administrator password reset; all sessions revoked.\n');
    }
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAdmin().catch(error => {
    const code = error instanceof AuthError || error instanceof DatabaseError ? error.code : 'administrator_operation_failed';
    process.stderr.write('Administrator command failed: ' + code + '\n');
    process.exitCode = 1;
  });
}

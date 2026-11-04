import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadHarnesses } from '../src/server/harness-config.ts';
import { dockerHostConfigurationSchema } from '../src/server/execution-host-docker.ts';

test('legacy managedWrites cannot grant editing without a controlled Host and legacy maintenance is rejected', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zh-host-config-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'), workspace = join(root, 'workspace'), file = join(root, 'config.json'); await mkdir(data); await mkdir(workspace);
  await writeFile(file, JSON.stringify({ workspaces: [{ id: 'lab', label: 'Lab', directory: workspace, managedWrites: true }], codex: { socketPath: join(root, 'absent.sock') } }), { mode: 0o600 });
  const value = await loadHarnesses(file, data); assert.equal(value.workspaces[0]!.managedWrites, false); await value.adapters.get('codex')!.close();
  await writeFile(file, JSON.stringify({ workspaces: [{ id: 'lab', label: 'Lab', directory: workspace, managedWrites: true }], dsh: { launchFile: join(root, 'absent'), maintenanceExecutable: join(root, 'legacy') } }), { mode: 0o600 });
  await assert.rejects(loadHarnesses(file, data), /legacy_maintenance_requires_managed_host_migration/);
});
test('managed workspace scope must equal real mount capability and writable auxiliary mounts cannot hide a workspace', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zh-host-config-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'product'), workspace = join(root, 'workspace'), native = join(root, 'native'), file = join(root, 'config.json'); for (const path of [data, workspace, native]) await mkdir(path);
  const host = { groupId: 'lab', harnessId: 'codex', workspaceIds: ['lab'], ledgerDirectory: join(root, 'ledger'), docker: { socketPath: '/var/run/docker.sock', ownershipPort: 39001, image: 'sha256:' + 'a'.repeat(64), argv: ['/usr/local/bin/node', '/runtime/native.js'], user: '1000:1000', mounts: [{ source: native, target: '/data', kind: 'data' }] }, native: { socketPath: join(root, 'native.sock'), tokenFile: join(root, 'native.token') }, gateway: { socketPath: join(root, 'gateway.sock'), tokenFile: join(root, 'gateway.token') } };
  let writerDirectory: string | undefined = join(root, 'writer');
  const write = () => writeFile(file, JSON.stringify({ workspaces: [{ id: 'lab', label: 'Lab', directory: workspace }], managedHosts: [host], workspaceWriterDirectory: writerDirectory }), { mode: 0o600 });
  await write(); await assert.rejects(loadHarnesses(file, data), /execution_workspace_mount_scope_mismatch/);
  host.docker.mounts.push({ source: workspace, target: workspace, kind: 'workspace' }); host.docker.mounts.push({ source: root, target: '/bypass', kind: 'runtime' });
  await write(); await assert.rejects(loadHarnesses(file, data), /execution_nonworkspace_mount_overlaps_workspace/);
  host.docker.mounts.pop(); writerDirectory = undefined; await write(); await assert.rejects(loadHarnesses(file, data), /managed_workspace_writer_directory_required/);
  writerDirectory = join(data, 'writer'); await write(); await assert.rejects(loadHarnesses(file, data), /unsafe_workspace_writer_directory/);
  writerDirectory = join(root, 'writer'); await write(); const parsed = await loadHarnesses(file, data); assert.equal(parsed.workspaces[0]!.managedWrites, true); assert.equal(parsed.managedHosts[0]!.docker.network, 'none');
  assert.equal(dockerHostConfigurationSchema.safeParse({ ...host.docker, user: '0:0' }).success, false);
  assert.equal(dockerHostConfigurationSchema.safeParse({ ...host.docker, restart: 'always' }).success, false);
});

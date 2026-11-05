import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NavigationUpdates } from '../src/web/navigation-updates.ts';
import type { ChangeEvent } from '../src/shared/workbench.ts';

test('archive progress does not invalidate a known navigation version or another workspace', () => {
  const updates = new NavigationUpdates();
  const event: ChangeEvent = { type: 'change', conversationId: randomUUID(), revision: 1, navigation: { workspaceId: 'busy', version: 'a'.repeat(64) } };
  const empty = updates.version('empty');
  assert.equal(updates.changed(event), 'busy'); updates.invalidate('busy');
  const busy = updates.version('busy'), all = updates.version();
  for (let revision = 2; revision < 102; revision++) assert.equal(updates.changed({ ...event, revision }), false);
  assert.equal(updates.version('empty'), empty); assert.equal(updates.version('busy'), busy); assert.equal(updates.version(), all);
  assert.equal(updates.changed({ ...event, navigation: { ...event.navigation!, version: 'b'.repeat(64) } }), 'busy');
  updates.invalidate('busy'); assert.notEqual(updates.version('busy'), busy); assert.notEqual(updates.version(), all); assert.equal(updates.version('empty'), empty);
  updates.invalidate(); assert.notEqual(updates.version('empty'), empty);
});

test('navigation hints remain bounded and conservative when old observations are evicted', () => {
  const updates = new NavigationUpdates(); const ids = Array.from({ length: 513 }, () => randomUUID());
  for (const [i, id] of ids.entries()) {
    assert.equal(updates.changed({ type: 'change', conversationId: id, revision: i, navigation: { workspaceId: 'w' + i, version: 'a'.repeat(64) } }), 'w' + i);
    updates.invalidate('w' + i);
  }
  assert.equal(updates.version('w0'), '0:0');
  assert.notEqual(updates.version('w512'), '0:0');
  assert.equal(updates.changed({ type: 'change', conversationId: ids[0]!, revision: 514, navigation: { workspaceId: 'w0', version: 'a'.repeat(64) } }), 'w0');
  assert.equal(updates.changed({ type: 'change', conversationId: randomUUID(), revision: 515 }), true);
});

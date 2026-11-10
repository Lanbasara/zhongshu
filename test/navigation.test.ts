import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHash, type Route } from '../src/web/navigation.ts';

const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const notice = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

test('every page has an address that reads back as the same page', () => {
  const routes: Route[] = [
    { kind: 'home' }, { kind: 'conversation', id }, { kind: 'draft' }, { kind: 'draft', workspaceId: 'haokun-stock' },
    { kind: 'draft', workspaceId: '主工作区' }, { kind: 'schedule' }, { kind: 'schedule', tab: 'tasks' }, { kind: 'settings' },
    { kind: 'settings', tab: 'account' }, { kind: 'archive' },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(routeHash(route)), route, JSON.stringify(route));
});
test('default tabs have the short address, and a notification marker is read but never written', () => {
  assert.equal(routeHash({ kind: 'schedule', tab: 'calendar' }), '#schedule');
  assert.equal(routeHash({ kind: 'settings', tab: 'workspaces' }), '#settings');
  assert.deepEqual(parseRoute(`#${id}:notice:${notice}`), { kind: 'conversation', id, notice });
  assert.equal(routeHash({ kind: 'conversation', id, notice }), `#${id}`);
});
test('unknown or malformed addresses open the home page', () => {
  for (const hash of ['', '#', '#nothing', '#schedule:Bad', `#${id}x`, '#settings:x/y', '#new:%E0%A4%A'])
    assert.deepEqual(parseRoute(hash), hash === '#new:%E0%A4%A' ? { kind: 'draft' } : { kind: 'home' }, hash);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestError, sendRefused } from '../src/web/workbench-client.ts';

test('a send refused before it was recorded gives the input back; an unknown outcome does not', () => {
  assert.equal(sendRefused(new RequestError('file_reference_unavailable', 409)), true);
  assert.equal(sendRefused(new RequestError('invalid_request', 400)), true);
  assert.equal(sendRefused(new RequestError('message_images_too_large', 413)), true);
  assert.equal(sendRefused(new RequestError('request_failed', 502)), false);
  assert.equal(sendRefused(new RequestError('empty_response')), false);
  assert.equal(sendRefused(new TypeError('Failed to fetch')), false);
});

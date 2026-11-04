import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metadataSearchExperiment } from './support/metadata-search.ts';

test('sparse and zero substring searches bound evaluated metadata, preserve exact semantics, and continue past empty pages', () => {
  const result = metadataSearchExperiment(1200);
  assert.equal(result.cleanup, true); assert.equal(result.scenarios.length, 3);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspacePreviewPages } from '../src/web/workspace-preview.ts';

test('large unsaved Markdown and oversized single blocks produce bounded previews without losing Unicode', () => {
  const cases = [
    Array.from({ length: 2000 }, (_, i) => `## Section ${i}\n\nText 中文🙂 ${'a'.repeat(100)}\n\n`).join(''),
    '```text\n' + ('a'.repeat(16383) + '🙂中文\n').repeat(12) + '\n```\n',
    '|列|内容|\n|--|--|\n' + '|中文|🙂 long table row|\n'.repeat(8000),
    'x'.repeat(16383) + '🙂'.repeat(100_000),
  ];
  for (const text of cases) {
    const pages = workspacePreviewPages(text, true);
    assert.ok(pages.length > 1);
    assert.equal(pages.map(page => page.text).join(''), text);
    for (const page of pages) {
      assert.ok(page.text.length <= 16 * 1024);
      assert.equal(Buffer.from(page.text, 'utf8').toString('utf8'), page.text);
    }
  }
  assert.ok(workspacePreviewPages(cases[1]!, true).some(page => page.raw));
  assert.ok(workspacePreviewPages(cases[2]!, true).some(page => page.raw));
});

test('small Markdown remains one rich page, including the empty document', () => {
  for (const text of ['', '# Title\n\nShort **Markdown** 🙂\n'])
    assert.deepEqual(workspacePreviewPages(text, false), [{ text, raw: false }]);
  assert.deepEqual(workspacePreviewPages('', true), [{ text: '', raw: false }]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { workspaceImages } from '../src/web/markdown.ts';

function render(item: string, text: string) {
  return renderToStaticMarkup(createElement(Streamdown, {
    mode: 'static', skipHtml: true,
    remarkPlugins: [...Object.values(defaultRemarkPlugins), [workspaceImages, { conversation: 'test-conversation', item }]],
    children: text,
  }));
}
test('workspace Markdown images keep per-message identity through the shared renderer cache', () => {
  const first = render('first-message','![Plot](plot.png)');
  const second = render('second-message','![Plot](plot.png)');
  assert.ok(first.includes('item=first-message'));
  assert.ok(second.includes('item=second-message'));
  assert.ok(!second.includes('item=first-message'));
  const fenced = render('code-message','```md\n![Plot](plot.png)\n```');
  assert.ok(!fenced.includes('/workspace-image?'));
  assert.ok(!render('traversal','![Bad](../outside.png)').includes('/workspace-image?'));
});
test('default Markdown sanitization still rejects script and executable URLs', () => {
  const html = render('unsafe','<script>globalThis.compromised=true</script>\n\n[bad](javascript:alert%281%29)\n\n<img src="x" onerror="globalThis.compromised=true">');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('onerror='));
  assert.ok(!html.includes('href="javascript:'));
});

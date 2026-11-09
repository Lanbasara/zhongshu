import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { markedWorkspacePath, workspaceImages, workspaceLink, workspaceLinks } from '../src/web/markdown.ts';

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
test('workspace links: relative document paths only, without fragment or query', () => {
  assert.equal(workspaceLink('2026-11-09/case-001/work/reviews.md'), '2026-11-09/case-001/work/reviews.md');
  assert.equal(workspaceLink('./notes/plan.md#today'), 'notes/plan.md');
  assert.equal(workspaceLink('reports/%E5%91%A8%E6%8A%A5.html?view=1'), 'reports/周报.html');
  for (const href of ['https://example.com/a.md', 'mailto:me@example.com', 'javascript:alert(1)', '/etc/passwd', '../secret.md',
    'notes/../../secret.md', '.env', 'notes/.git/config', '#section', '//example.com/a', 'C:\\notes.md', '%E0%A4%A', ''])
    assert.equal(workspaceLink(href), undefined, href);
});
test('workspace links cross the URL hardener as marked links; unmarked bare paths stay blocked', () => {
  const view = (plugins: unknown[]) => renderToStaticMarkup(createElement(Streamdown, {
    mode: 'static', skipHtml: true, remarkPlugins: [...Object.values(defaultRemarkPlugins), ...plugins] as never,
    components: { a: ({ href, children }: { href?: string; children?: unknown }) => createElement('a', { href }, children as never) } as never,
    children: '记录已追加到 [reviews.md](2026-11-09/case-001/work/reviews.md)，[报告][r]，[外链](https://example.com/x)，[越界](../secret.md)。\n\n[r]: reports/%E5%91%A8%E6%8A%A5.html',
  }));
  assert.ok(view([]).includes('reviews.md [blocked]'));
  const marked = view([workspaceLinks]);
  const hrefs = [...marked.matchAll(/href="([^"]+)"/g)].map(match => match[1]!);
  // Only marked links name workspace files; the hardener's own relative rewrite of ../secret.md is not one.
  assert.deepEqual(hrefs.map(href => markedWorkspacePath(href) ?? `not a file: ${href}`),
    ['2026-11-09/case-001/work/reviews.md', 'reports/周报.html', 'not a file: https://example.com/x', 'not a file: /secret.md']);
  assert.equal(markedWorkspacePath('/__workspace/..%2Fsecret.md'), undefined);
  assert.equal(markedWorkspacePath('/api/private/x'), undefined);
});

import { referenceSchema } from '../shared/content.ts';

type Node = { type: string; url?: string; children?: Node[] };
/** Resolve image AST nodes, never code/text, before the default URL hardener. */
export function workspaceImages(options: { conversation: string; item: string }) {
  return function visit(node: Node): void {
    if (node.type === 'image' && node.url) {
      try {
        const path = decodeURIComponent(node.url).replace(/^\.\//, '');
        if (referenceSchema.safeParse({ type: 'file', path }).success) node.url = `/api/private/workbench/conversations/${encodeURIComponent(options.conversation)}/workspace-image?item=${encodeURIComponent(options.item)}&source=${encodeURIComponent(node.url)}`;
      } catch { /* Invalid encodings remain subject to the default sanitizer. */ }
    }
    node.children?.forEach(visit);
  };
}

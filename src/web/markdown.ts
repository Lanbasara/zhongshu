import { referenceSchema, workspaceDocumentPath } from '../shared/content.ts';

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

/**
 * A link an agent wrote to a file of its workspace, as the workspace-relative path the reader opens; a fragment or
 * query is dropped. Absolute paths, parent segments, hidden files and any scheme are not workspace links.
 */
export function workspaceLink(href: string): string | undefined {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  let path: string;
  try { path = decodeURIComponent(href.split(/[?#]/)[0]!).replace(/^\.\//, ''); } catch { return undefined; }
  return workspaceDocumentPath.safeParse(path).success ? path : undefined;
}

/** Workspace links cross the URL hardener under this same-origin path; only the transcript turns them back into files. */
const WORKSPACE_LINK = '/__workspace/';
/** Mark link nodes (and reference definitions) that point into the workspace, before the default URL hardener. */
export function workspaceLinks() {
  return function visit(node: Node): void {
    if ((node.type === 'link' || node.type === 'definition') && node.url) {
      const path = workspaceLink(node.url);
      if (path !== undefined) node.url = WORKSPACE_LINK + path.split('/').map(encodeURIComponent).join('/');
    }
    node.children?.forEach(visit);
  };
}
/** The workspace path a marked link names, if it is one. */
export function markedWorkspacePath(href: string): string | undefined {
  if (!href.startsWith(WORKSPACE_LINK)) return undefined;
  try {
    const path = href.slice(WORKSPACE_LINK.length).split('/').map(decodeURIComponent).join('/');
    return workspaceDocumentPath.safeParse(path).success ? path : undefined;
  } catch { return undefined; }
}

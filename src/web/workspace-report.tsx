import { useMemo, useRef } from 'react';

const elements = new Set('a abbr article aside b blockquote br caption cite code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img kbd li main mark nav ol p pre s samp section small span strong sub summary sup table tbody td th thead time tr u ul var'.split(' '));
const svgElements = new Set('svg g path rect circle ellipse line polyline polygon text tspan title desc defs linearGradient radialGradient stop'.split(' '));
const attributes = new Set('id class style title alt width height colspan rowspan scope open start dir lang role'.split(' '));
const svgAttributes = new Set('viewBox preserveAspectRatio x y x1 x2 y1 y2 cx cy r rx ry d points fill stroke stroke-width transform opacity offset stop-color text-anchor font-size'.split(' '));
const blocked = new Set('script noscript iframe object embed form input button textarea select link meta base template audio video source'.split(' '));
const shell = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src-attr \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"></head><body></body></html>';

function prepare(source: string) {
  // Template contents are inert. Only reconstructed elements enter the scriptless frame.
  const input = document.createElement('template');
  input.innerHTML = source;
  const styles = [...input.content.querySelectorAll('style')].map(node => node.textContent ?? '');
  const output = document.createDocumentFragment();
  function copy(node: Node, parent: Node, depth: number): void {
    if (depth > 100) return;
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.textContent ?? '')); return; }
    if (!(node instanceof Element)) return;
    const tag = node.localName;
    if (tag === 'style' || blocked.has(tag)) return;
    const svg = node.namespaceURI === 'http://www.w3.org/2000/svg';
    if (!(svg ? svgElements : elements).has(tag)) {
      node.childNodes.forEach(child => copy(child, parent, depth + 1));
      return;
    }
    const safe = svg ? document.createElementNS(node.namespaceURI, tag) : document.createElement(tag);
    for (const attribute of node.attributes) {
      if (attributes.has(attribute.name) || (svg && svgAttributes.has(attribute.name))) safe.setAttribute(attribute.name, attribute.value);
    }
    if (tag === 'a') {
      const target = node.getAttribute('href');
      if (target && target.length <= 2048) {
        safe.setAttribute('href', '#');
        safe.setAttribute('data-report-target', target);
      }
    }
    if (tag === 'img') {
      const source = node.getAttribute('src') ?? '';
      if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(source)) safe.setAttribute('src', source);
    }
    parent.appendChild(safe);
    node.childNodes.forEach(child => copy(child, safe, depth + 1));
  }
  input.content.childNodes.forEach(node => copy(node, output, 0));
  return { output, styles };
}

export function WorkspaceReport({ text, title, position, navigate }: {
  text: string; title: string; position: number; navigate(target: string, position: number): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const report = useMemo(() => prepare(text), [text]);
  return <iframe ref={frame} className="workspace-report" title={title} sandbox="allow-same-origin" srcDoc={shell}
    onLoad={() => {
      const doc = frame.current?.contentDocument;
      const view = frame.current?.contentWindow;
      if (!doc || !view || !doc.body) return;
      const Sheet = (view as Window & typeof globalThis).CSSStyleSheet;
      const sheet = new Sheet();
      sheet.replaceSync('body{margin:20px;color:#292929;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}pre{overflow:auto}table{display:block;overflow:auto}' + report.styles.join('\n'));
      doc.adoptedStyleSheets = [sheet];
      doc.body.replaceChildren(report.output.cloneNode(true));
      doc.onclick = event => {
        const target = event.target as Element | null;
        const anchor = target?.closest?.('a[data-report-target]');
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute('data-report-target')!;
        if (href.startsWith('#')) {
          try { doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); } catch { /* Invalid fragment. */ }
        } else navigate(href, view.scrollY);
      };
      view.scrollTo(0, position);
    }}/>;
}

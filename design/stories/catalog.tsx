import { useState, type CSSProperties, type ReactNode } from 'react';
import './catalog.css';

/** Story-only helpers. Nothing here is imported by the product. */

/** Story globals for the phone viewport defined in .storybook/preview.tsx (below the product's 760px breakpoint). */
export const phone = { viewport: { value: 'phone', isRotated: false } };

export function Page({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return <div className="catalog-page"><header><h1>{title}</h1>{lead && <p>{lead}</p>}</header>{children}</div>;
}

export function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return <section className="catalog-section"><h2>{title}</h2>{note && <p>{note}</p>}<div className="catalog-body">{children}</div></section>;
}

export function Stage({ children, tone, stack, style }: { children: ReactNode; tone?: 'sidebar'; stack?: boolean; style?: CSSProperties }) {
  return <div className="catalog-stage" data-tone={tone} data-stack={stack || undefined} style={style}>{children}</div>;
}

/** Shows what a callback would have done; the catalog never sends anything anywhere. */
export function useReadout(initial = '尚未操作') {
  const [text, setText] = useState(initial);
  return [<p key="readout" className="catalog-readout" role="status">{text}</p>, setText] as const;
}

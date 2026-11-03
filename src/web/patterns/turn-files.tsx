import { useId, useState } from 'react';
import { ArrowUpRight, ChevronDown, Files, FileText } from 'lucide-react';
import { Button } from '../ui/controls.tsx';
import './turn-files.css';

export type TurnFile = { path: string; unavailable?: boolean };

const previewCount = 3;

/** Paths are display data. The workbench owns resolution, access, and navigation. */
export function TurnFiles({ files, limited, activePath, onOpen }: {
  files: readonly TurnFile[];
  limited?: boolean;
  activePath?: string;
  onOpen(path: string, trigger: HTMLButtonElement): void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  if (!files.length) return null;
  const extraCount = files.length - previewCount;

  return <section className="turn-files" aria-labelledby={id + '-title'}>
    <header className="turn-files-header">
      <h2 id={id + '-title'}><Files size={16} aria-hidden="true"/>本轮文件</h2>
      <span className="turn-files-count">{limited ? '显示前' : '记录到'} {files.length} 个</span>
    </header>
    <ul role="list" className="turn-files-list" id={id + '-list'}>
      {files.map(({ path, unavailable }, index) => {
        const separator = path.lastIndexOf('/') + 1;
        const name = path.slice(separator);
        const directory = path.slice(0, separator);
        const label = <>
          <span className="turn-files-icon"><FileText size={14} aria-hidden="true"/></span>
          <span className="turn-files-label"><strong>{name}</strong>{directory && <small>{directory}</small>}</span>
        </>;
        return <li key={path} tabIndex={unavailable ? -1 : undefined} hidden={!expanded && index >= previewCount}>
          {unavailable ? <div className="turn-files-row">
            {label}<span className="turn-files-unavailable">当前不可用</span>
          </div> : <button type="button" className="turn-files-row" title={path}
            aria-label={`在工作区打开 ${path}`} aria-current={activePath === path || undefined}
            onClick={event => onOpen(path, event.currentTarget)}>
            {label}<ArrowUpRight size={15} aria-hidden="true"/>
          </button>}
        </li>;
      })}
    </ul>
    {extraCount > 0 && <Button variant="quiet" className="turn-files-toggle" aria-controls={id + '-list'}
      aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起文件' : `再显示 ${extraCount} 个文件`}<ChevronDown size={14} aria-hidden="true"/>
    </Button>}
  </section>;
}

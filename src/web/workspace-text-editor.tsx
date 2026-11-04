import { useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { createWorkspaceEditorState, externalWorkspaceEditorState, workspaceEditorValue } from './workspace-text-editor-state.ts';
import './workspace-text-editor.css';

type Props = { value: string; onChange(value: string): void; readOnly: boolean; hidden: boolean };
type Editor = {
  view: EditorView; value: string; readOnly: boolean; permission: Compartment;
  extensions(readOnly: boolean): Extension; scrollTop: number; scrollLeft: number;
};
function permissionExtensions(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({
    role: 'textbox', 'aria-label': '文件原文', 'aria-multiline': 'true', 'aria-readonly': String(readOnly),
    tabindex: '0', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off',
  })];
}

// A shadow root lets the library install its fixed styles with constructed
// stylesheets. No inline-style CSP exception, nonce, or file content is needed.
// Allocate this theme once: style-mod retains mounted modules per document.
const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--zs-text)', backgroundColor: 'var(--zs-surface)', fontSize: 'var(--zs-type-input)' },
  '&.cm-focused': { outline: '2px solid var(--zs-focus)', outlineOffset: '-2px' },
  '.cm-scroller': { minHeight: '0', overflow: 'auto', fontFamily: 'var(--zs-font-code)', lineHeight: 'var(--zs-line-body)' },
  '.cm-content': { padding: 'var(--zs-space-2) 0', caretColor: 'var(--zs-text)' },
  '.cm-line': { padding: '0 var(--zs-space-2)' },
  '.cm-content[contenteditable=false]': { cursor: 'text' },
  '.cm-cursor': { borderLeftColor: 'var(--zs-text)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--zs-selection)' },
});

/** Local plain text only. The caller owns draft persistence and save authority. */
export default function WorkspaceTextEditor({ value, onChange, readOnly, hidden }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const change = useRef(onChange);
  useLayoutEffect(() => { change.current = onChange; }, [onChange]);

  useLayoutEffect(() => {
    const parent = host.current!;
    const root = parent.shadowRoot ?? parent.attachShadow({ mode: 'open' });
    const permission = new Compartment();
    const extensions = (locked: boolean): Extension => [
      permission.of(permissionExtensions(locked)),
      // Standard browser-like navigation, text commands and undo/redo. Tab
      // retains its normal focus behavior rather than trapping keyboard users.
      keymap.of([...defaultKeymap, ...historyKeymap]), drawSelection(), EditorView.lineWrapping, editorTheme,
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        const current = editor.current;
        if (!current) return;
        const text = workspaceEditorValue(update.state);
        current.value = text;
        change.current(text);
      }),
    ];
    const view = new EditorView({ parent: root, root, state: createWorkspaceEditorState(value, extensions(readOnly)) });
    const current: Editor = { view, value, readOnly, permission, extensions, scrollTop: 0, scrollLeft: 0 };
    editor.current = current;
    const rememberScroll = () => {
      if (parent.hidden) return;
      current.scrollTop = view.scrollDOM.scrollTop; current.scrollLeft = view.scrollDOM.scrollLeft;
    };
    view.scrollDOM.addEventListener('scroll', rememberScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener('scroll', rememberScroll);
      editor.current = null; view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const current = editor.current;
    if (!current) return;
    // Avoid serializing or replacing the document again for the ordinary
    // controlled echo. In particular, do not interrupt an IME composition.
    if (value !== current.value) {
      const state = externalWorkspaceEditorState(current.view.state, value, current.extensions(readOnly));
      current.value = value;
      if (state) { current.view.setState(state); current.readOnly = readOnly; }
    }
    if (readOnly !== current.readOnly) {
      current.view.dispatch({ effects: current.permission.reconfigure(permissionExtensions(readOnly)) });
      current.readOnly = readOnly;
    }
  }, [value, readOnly]);

  useLayoutEffect(() => {
    const current = editor.current;
    if (!current || hidden) return;
    current.view.scrollDOM.scrollTop = current.scrollTop;
    current.view.scrollDOM.scrollLeft = current.scrollLeft;
    current.view.requestMeasure();
  }, [hidden]);

  return <div ref={host} className="workspace-text-editor" hidden={hidden}/>;
}

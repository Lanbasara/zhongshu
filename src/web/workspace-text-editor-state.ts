import { EditorSelection, EditorState, Facet, type Extension } from '@codemirror/state';
import { history } from '@codemirror/commands';

const byteOrderMark = Facet.define<boolean, boolean>({ combine: values => values[0] ?? false });

/** A leading BOM is encoding metadata, not an editable character. */
export function workspaceEditorValue(state: EditorState): string {
  return (state.facet(byteOrderMark) ? '\ufeff' : '') + state.doc.toString();
}

/** Split only LF: CR in CRLF or mixed files and lone CR remain text. */
export function createWorkspaceEditorState(value: string, extensions: Extension = [], selection?: EditorSelection): EditorState {
  const bom = value.startsWith('\ufeff');
  return EditorState.create({ doc: bom ? value.slice(1) : value, selection,
    extensions: [byteOrderMark.of(bom), EditorState.lineSeparator.of('\n'), history(), extensions] });
}

/** A controlled echo keeps the exact state, including selection and undo.
 * A genuinely different external document starts a fresh history, so undo
 * cannot restore edits from an obsolete file version into the refreshed file.
 */
export function externalWorkspaceEditorState(state: EditorState, value: string, extensions: Extension = []): EditorState | null {
  if (workspaceEditorValue(state) === value) return null;
  const length = value.length - (value.startsWith('\ufeff') ? 1 : 0);
  const selection = EditorSelection.create(state.selection.ranges.map(range => EditorSelection.range(
    Math.min(range.anchor, length), Math.min(range.head, length),
  )), state.selection.mainIndex);
  return createWorkspaceEditorState(value, extensions, selection);
}

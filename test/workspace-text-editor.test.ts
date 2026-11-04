import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { insertNewlineAndIndent, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { createWorkspaceEditorState, externalWorkspaceEditorState, workspaceEditorValue } from '../src/web/workspace-text-editor-state.ts';

test('workspace editor preserves exact BOM, mixed newline and pasted text through undo and redo', () => {
  const original = '\ufefffirst\r\n第二行🙂\nthird\rfourth\r\n';
  const pasted = 'paste\r\n粘贴\r孤立\n';
  let state = createWorkspaceEditorState(original);
  assert.equal(workspaceEditorValue(state), original);
  const cursor = state.doc.toString().indexOf('第二');
  state = state.update({ selection: EditorSelection.cursor(cursor) }).state;
  state = state.update({ changes: { from: cursor, insert: pasted }, selection: { anchor: cursor + pasted.length }, userEvent: 'input.paste' }).state;
  const modified = original.slice(0, cursor + 1) + pasted + original.slice(cursor + 1);
  assert.equal(workspaceEditorValue(state), modified);
  assert.equal(undoDepth(state), 1);
  const target = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  assert.equal(undo(target), true); assert.equal(workspaceEditorValue(state), original); assert.equal(redoDepth(state), 1);
  assert.equal(redo(target), true); assert.equal(workspaceEditorValue(state), modified);
});

test('controlled echoes preserve selection and undo; external refresh establishes exact text and fresh history', () => {
  let state = createWorkspaceEditorState('\ufeffold\r\nvalue\n');
  state = state.update({ changes: { from: 4, insert: ' change' }, selection: EditorSelection.range(1, 11), userEvent: 'input' }).state;
  const prior = state, selection = state.selection;
  assert.equal(externalWorkspaceEditorState(state, workspaceEditorValue(state)), null);
  assert.equal(state, prior); assert.equal(state.selection, selection); assert.equal(undoDepth(state), 1);
  const refreshed = '\ufeff新\r\n';
  state = externalWorkspaceEditorState(state, refreshed)!;
  assert.equal(workspaceEditorValue(state), refreshed);
  assert.equal(state.selection.main.anchor, 1); assert.equal(state.selection.main.head, refreshed.length - 1);
  assert.equal(undoDepth(state), 0); assert.equal(redoDepth(state), 0);
});

test('editing the first character and replacing all text keep the original BOM at byte zero', () => {
  let state = createWorkspaceEditorState('\ufeffalpha\r\nbeta\n');
  assert.equal(state.doc.toString(), 'alpha\r\nbeta\n');
  state = state.update({ changes: { from: 0, insert: 'B' }, userEvent: 'input' }).state;
  assert.equal(workspaceEditorValue(state), '\ufeffBalpha\r\nbeta\n');
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: '中文🙂\r\n' }, userEvent: 'input.paste' }).state;
  assert.equal(workspaceEditorValue(state), '\ufeff中文🙂\r\n');
  state = externalWorkspaceEditorState(state, 'no BOM\r\n')!;
  assert.equal(workspaceEditorValue(state), 'no BOM\r\n');
});

test('read-only reconfiguration blocks edit and undo commands while retaining selection and history', () => {
  const permission = new Compartment();
  let state = createWorkspaceEditorState('keep\r\n', permission.of(EditorState.readOnly.of(false)));
  state = state.update({ changes: { from: 4, insert: '!' }, selection: { anchor: 5 }, userEvent: 'input' }).state;
  state = state.update({ effects: permission.reconfigure(EditorState.readOnly.of(true)) }).state;
  const target = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  assert.equal(insertNewlineAndIndent(target), false); assert.equal(undo(target), false);
  assert.equal(state.doc.toString(), 'keep!\r\n'); assert.equal(undoDepth(state), 1);
  state = state.update({ selection: EditorSelection.range(0, state.doc.length) }).state;
  assert.equal(state.selection.main.to, state.doc.length);
  state = state.update({ effects: permission.reconfigure(EditorState.readOnly.of(false)) }).state;
  assert.equal(undo(target), true); assert.equal(state.doc.toString(), 'keep\r\n');
});

import { rust } from '@codemirror/lang-rust';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Graph } from './types';

type Range = readonly [start: number, end: number];

const setRange = StateEffect.define<Range>();

const rangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setRange)) continue;
      const doc = tr.state.doc;
      const [start, end] = e.value;
      const marks = [];
      for (let n = Math.max(1, start); n <= Math.min(end, doc.lines); n++) {
        marks.push(Decoration.line({ class: 'cm-fn-range' }).range(doc.line(n).from));
      }
      return Decoration.set(marks);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.self], color: 'var(--tok-keyword)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tok-fn)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--tok-type)' },
  { tag: [t.string, t.character], color: 'var(--tok-string)' },
  { tag: [t.number, t.bool], color: 'var(--tok-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [t.macroName, t.attributeName], color: 'var(--tok-macro)' },
]);

const extensions: Extension[] = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  lineNumbers(),
  rust(),
  syntaxHighlighting(highlight),
  rangeField,
];

export interface CodePanel {
  show(fnId: number): Promise<void>;
}

export function createCodePanel(root: HTMLElement, graph: Graph): CodePanel {
  const sources = new Map<number, Promise<string>>();
  const source = (fileId: number): Promise<string> => {
    let p = sources.get(fileId);
    if (!p) {
      p = fetch(`/api/source/${fileId}`).then((r) => {
        if (!r.ok) throw new Error(`the server returned HTTP ${r.status}`);
        return r.text();
      });
      p.catch(() => sources.delete(fileId));
      sources.set(fileId, p);
    }
    return p;
  };

  root.replaceChildren(
    el('p', 'panel-empty', 'Click a function in the graph, or search for one, to read its source.'),
  );
  const fnLine = el('p', 'panel-fn');
  const pathLine = el('p', 'panel-path');
  const head = el('header', 'panel-head');
  head.append(fnLine, pathLine);
  const body = el('div', 'panel-code');
  const view = new EditorView({ parent: body, state: EditorState.create({ extensions }) });

  let shownFile: number | null = null;
  let latest = 0;

  return {
    async show(fnId) {
      const fn = graph.fns[fnId];
      if (!fn) return;
      const file = graph.files[fn.file]!;
      const request = ++latest;
      if (!head.isConnected) root.replaceChildren(head, body);
      fnLine.textContent = fn.label;
      pathLine.textContent = `${file.path}:${fn.lines[0]}-${fn.lines[1]}`;

      if (shownFile !== fn.file) {
        let text: string;
        try {
          text = await source(fn.file);
        } catch (err) {
          if (request !== latest) return;
          shownFile = null;
          root.replaceChildren(head, el('p', 'panel-error', `Could not load ${file.path}: ${err instanceof Error ? err.message : String(err)}.`));
          return;
        }
        if (request !== latest) return;
        if (!body.isConnected) root.replaceChildren(head, body);
        view.setState(EditorState.create({ doc: text, extensions }));
        shownFile = fn.file;
      }

      const doc = view.state.doc;
      const startLine = doc.line(Math.min(Math.max(1, fn.lines[0]), doc.lines));
      view.dispatch({
        effects: [setRange.of(fn.lines), EditorView.scrollIntoView(startLine.from, { y: 'center' })],
      });
    },
  };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

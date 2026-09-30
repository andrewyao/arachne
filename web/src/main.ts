import './style.css';
import { createCodePanel } from './code-panel';
import { createGraphView } from './graph-view';
import { fileKey, fnKey } from './project';
import { createSearch } from './search';
import type { Graph } from './types';

async function main() {
  const res = await fetch('/api/graph');
  if (!res.ok) throw new Error(`GET /api/graph failed: HTTP ${res.status}`);
  const graph: Graph = await res.json();

  const panel = createCodePanel(document.getElementById('panel')!, graph);
  const view = createGraphView(document.getElementById('graph')!, graph, (fnId) => void panel.show(fnId));

  createSearch(document.getElementById('search')!, graph, (pick) => {
    switch (pick.kind) {
      case 'file':
        view.expand(pick.id);
        view.focus(fileKey(pick.id));
        return;
      case 'fn':
        view.expand(graph.fns[pick.id]!.file);
        view.select(pick.id);
        view.focus(fnKey(pick.id));
        void panel.show(pick.id);
    }
  });
}

main().catch((err: unknown) => {
  const p = document.createElement('p');
  p.className = 'panel-error';
  p.textContent = `Could not load the call graph. ${String(err)}`;
  document.getElementById('graph')!.replaceChildren(p);
});

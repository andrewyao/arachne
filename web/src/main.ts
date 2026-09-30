import './style.css';
import { createCodePanel } from './code-panel';
import { createContextMenu, type MenuItem } from './context-menu';
import { createGraphView } from './graph-view';
import { createHiddenList } from './hidden-list';
import { createHiddenStore } from './hidden-store';
import { createModeToggle } from './mode-toggle';
import { createPanelToggle } from './panel-toggle';
import { fileKey, fnKey } from './project';
import { createSearch, type Absence, type Pick } from './search';
import type { Graph } from './types';
import { fileHiddenKey, fnHiddenKey, hiddenKeyIndex, type HiddenTarget } from './visibility';

async function main() {
  const res = await fetch('/api/graph');
  if (!res.ok) throw new Error(`GET /api/graph failed: HTTP ${res.status}`);
  const graph: Graph = await res.json();

  const panel = createCodePanel(document.getElementById('panel')!, graph);
  const toggle = createPanelToggle(
    document.getElementById('app')!,
    document.getElementById('panel-hide') as HTMLButtonElement,
    document.getElementById('panel-show') as HTMLButtonElement,
  );
  const openFn = (fnId: number) => {
    toggle.open();
    void panel.show(fnId);
  };
  const hidden = createHiddenStore(graph.project);
  const keyIndex = hiddenKeyIndex(graph);
  const menu = createContextMenu();
  const view = createGraphView(document.getElementById('graph')!, graph, { index: keyIndex, keys: hidden.keys() }, {
    onOpenFn: openFn,
    onContextMenu(target, e) {
      const key = target.kind === 'file' ? fileHiddenKey(graph, target.id) : fnHiddenKey(graph, target.id);
      const items: MenuItem[] = [
        { label: target.kind === 'file' ? 'Hide file' : 'Hide function', run: () => hidden.add(key) },
      ];
      const count = target.kind === 'file' ? view.privateCount(target.id) : 0;
      if (count > 0) {
        const shown = view.isPrivateShown(target.id);
        items.push({
          label: shown ? 'Hide private fns' : 'Show private fns',
          detail: String(count),
          run: () => view.setPrivateShown(target.id, !shown),
        });
      }
      const title = target.kind === 'file' ? graph.files[target.id]!.label : graph.fns[target.id]!.label;
      menu.open(e.clientX, e.clientY, title, items);
    },
  });
  hidden.subscribe((keys) => view.setHidden(keys));
  const openTarget = (t: HiddenTarget) => {
    if (t.kind === 'fn') return openFn(t.id);
    toggle.open();
    void panel.showFile(t.id);
  };
  createHiddenList(document.getElementById('hidden')!, graph, hidden, keyIndex, openTarget);

  const hint = document.getElementById('hint')!;
  const manualHint = hint.textContent;
  createModeToggle(document.getElementById('mode')!, (mode) => {
    view.setMode(mode);
    hint.textContent =
      mode === 'all' ? 'Every file is expanded. Switch back to Manual, or press E, to return to your own selection.' : manualHint;
  });

  const absence = (pick: Pick): Absence => {
    if (view.isUserHidden(pick)) return 'hidden';
    return view.isPrivateHidden(pick) ? 'private' : null;
  };
  const pickResult = (pick: Pick) => {
    // A hidden item stays hidden: the user set it aside, so picking it only reads its code.
    if (view.isUserHidden(pick)) return openTarget(pick);
    if (view.isPrivateHidden(pick)) view.setPrivateShown(pick.kind === 'file' ? pick.id : graph.fns[pick.id]!.file, true);
    switch (pick.kind) {
      case 'file':
        view.expand(pick.id);
        view.focus(fileKey(pick.id));
        return;
      case 'fn':
        view.expand(graph.fns[pick.id]!.file);
        view.select(pick.id);
        view.focus(fnKey(pick.id));
        openFn(pick.id);
    }
  };
  createSearch(document.getElementById('search')!, graph, pickResult, absence);
}

main().catch((err: unknown) => {
  const p = document.createElement('p');
  p.className = 'panel-error';
  p.textContent = `Could not load the call graph. ${String(err)}`;
  document.getElementById('graph')!.replaceChildren(p);
});

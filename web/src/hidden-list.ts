import type { HiddenStore } from './hidden-store';
import type { Graph } from './types';
import { parseHiddenKey, type HiddenKey, type HiddenTarget } from './visibility';

const COLLAPSED_KEY = 'arachne.hiddenListCollapsed';

export function createHiddenList(
  root: HTMLElement,
  graph: Graph,
  store: HiddenStore,
  index: ReadonlyMap<HiddenKey, HiddenTarget>,
  onOpen: (target: HiddenTarget) => void,
): void {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'hidden-toggle';
  toggle.setAttribute('aria-controls', 'hidden-body');
  const title = document.createElement('span');
  title.textContent = 'Hidden';
  const count = document.createElement('span');
  count.className = 'hidden-count';
  toggle.append(chevron(), title, count);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'hidden-clear';
  clear.textContent = 'Unhide all';
  clear.addEventListener('click', () => store.clear());

  const head = document.createElement('header');
  head.className = 'hidden-head';
  head.append(toggle, clear);

  const body = document.createElement('div');
  body.id = 'hidden-body';
  body.className = 'hidden-body';
  root.replaceChildren(head, body);

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    // Storage can be unavailable; the section starts open.
  }
  const setCollapsed = (next: boolean) => {
    collapsed = next;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    body.hidden = collapsed;
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // As above.
    }
  };
  toggle.addEventListener('click', () => setCollapsed(!collapsed));
  setCollapsed(collapsed);

  const render = (keys: readonly HiddenKey[]) => {
    count.textContent = String(keys.length);
    clear.hidden = keys.length === 0;
    if (!keys.length) {
      const empty = document.createElement('p');
      empty.className = 'hidden-empty';
      empty.textContent = 'Right-click a node and choose Hide to set it aside here.';
      body.replaceChildren(empty);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'hidden-list';
    list.append(...keys.map((key) => row(key, index.get(key))));
    body.replaceChildren(list);
  };

  const row = (key: HiddenKey, target: HiddenTarget | undefined): HTMLLIElement => {
    const li = document.createElement('li');
    const named = parseHiddenKey(key);
    const kind = named.kind;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'hidden-open';
    const dot = document.createElement('span');
    dot.className = `kind ${kind}`;
    const label = document.createElement('span');
    label.className = 'hidden-label';
    open.append(dot, label);
    if (target) {
      label.textContent = target.kind === 'file' ? graph.files[target.id]!.label : graph.fns[target.id]!.label;
      open.title = `Open ${target.kind === 'file' ? graph.files[target.id]!.path : label.textContent}`;
      open.addEventListener('click', () => onOpen(target));
    } else {
      li.classList.add('missing');
      label.textContent = named.kind === 'fn' ? named.fn : named.path;
      open.disabled = true;
      open.title = `${named.kind === 'fn' ? `${named.fn} in ${named.path}` : named.path} is no longer in the graph`;
      const tag = document.createElement('span');
      tag.className = 'hidden-tag';
      tag.textContent = 'missing';
      open.append(tag);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'hidden-remove';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Unhide ${label.textContent}`);
    remove.title = 'Unhide';
    remove.addEventListener('click', () => store.remove(key));
    li.append(open, remove);
    return li;
  };

  render(store.keys());
  store.subscribe(render);
}

function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4.5 6 8 9.5 11.5 6');
  svg.append(path);
  return svg;
}

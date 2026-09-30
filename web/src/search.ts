import type { Graph } from './types';

export type Pick = { kind: 'fn'; id: number } | { kind: 'file'; id: number };

interface Candidate {
  pick: Pick;
  label: string;
  lower: string;
}

export interface Match {
  score: number;
  positions: number[];
}

const isBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  return '.:/_<> '.includes(prev) || (prev === prev.toLowerCase() && text[i] !== text[i]!.toLowerCase());
};

// Tries every start position of the first query char so "helper" prefers the
// boundary-aligned run in "ui.render::helper" over scattered earlier letters.
export function fuzzyMatch(query: string, text: string, lower = text.toLowerCase()): Match | null {
  const q = query.toLowerCase();
  if (!q) return null;
  let best: Match | null = null;
  for (let start = lower.indexOf(q[0]!); start !== -1; start = lower.indexOf(q[0]!, start + 1)) {
    const positions = [start];
    let score = isBoundary(text, start) ? 3 : 1;
    let at = start;
    for (let k = 1; k < q.length; k++) {
      const next = lower.indexOf(q[k]!, at + 1);
      if (next === -1) return best;
      score += next === at + 1 ? 3 : isBoundary(text, next) ? 2 : 1;
      positions.push(next);
      at = next;
    }
    score -= text.length * 0.01;
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

const LIMIT = 50;

export function createSearch(root: HTMLElement, graph: Graph, onPick: (pick: Pick) => void): void {
  const candidates: Candidate[] = [];
  graph.files.forEach((file, id) => {
    if (file.fns[0] === file.fns[1]) return;
    candidates.push({ pick: { kind: 'file', id }, label: file.label, lower: file.label.toLowerCase() });
  });
  graph.fns.forEach((fn, id) =>
    candidates.push({ pick: { kind: 'fn', id }, label: fn.label, lower: fn.label.toLowerCase() }),
  );

  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search functions and files  ( / )';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'search-results');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = document.createElement('ul');
  list.id = 'search-results';
  list.className = 'results';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  root.replaceChildren(input, list);

  let results: { c: Candidate; m: Match }[] = [];
  let active = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  const setActive = (i: number) => {
    const items = list.children;
    items[active]?.setAttribute('aria-selected', 'false');
    active = i;
    const item = items[active];
    item?.setAttribute('aria-selected', 'true');
    item?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    close();
    input.blur();
    onPick(r.c.pick);
  };

  const render = () => {
    const q = input.value.trim();
    if (!q) {
      results = [];
      close();
      return;
    }
    results = [];
    for (const c of candidates) {
      const m = fuzzyMatch(q, c.label, c.lower);
      if (m) results.push({ c, m });
    }
    results.sort((a, b) => b.m.score - a.m.score);
    results.length = Math.min(results.length, LIMIT);

    list.replaceChildren(
      ...(results.length === 0
        ? [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No function or file matches.' })]
        : results.map((r, i) => {
            const li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', 'false');
            const dot = document.createElement('span');
            dot.className = `kind ${r.c.pick.kind}`;
            const label = document.createElement('span');
            label.className = 'label';
            label.append(...highlighted(r.c.label, r.m.positions));
            li.append(dot, label);
            li.addEventListener('mousedown', (e) => {
              e.preventDefault();
              choose(i);
            });
            return li;
          })),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = 0;
    setActive(0);
  };

  input.addEventListener('input', render);
  input.addEventListener('focus', () => input.value.trim() && render());
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      input.value = '';
      close();
      input.blur();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
}

function highlighted(text: string, positions: number[]): Node[] {
  const out: Node[] = [];
  const hit = new Set(positions);
  let run = '';
  let runHit = false;
  const flush = () => {
    if (!run) return;
    if (runHit) {
      const mark = document.createElement('mark');
      mark.textContent = run;
      out.push(mark);
    } else out.push(document.createTextNode(run));
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const h = hit.has(i);
    if (h !== runHit) {
      flush();
      runHit = h;
    }
    run += text[i];
  }
  flush();
  return out;
}

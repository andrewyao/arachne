import type { Graph } from './types';

// Decides which fns and files get a node, and which edges connect them. Two independent rules:
// - The user's hidden list drops nodes outright, with every edge touching them.
// - Private fns with a caller are contracted away: calls through them become `via` edges.
// The hidden list applies first, so no contracted path runs through a node the user hid.

/**
 * `file:<path>` or `fn:<path>#<fn key>`. Stable across re-index, unlike ids and labels. `%` and
 * `#` in the path are escaped, so the first `#` always ends the path.
 */
export type HiddenKey = (`file:${string}` | `fn:${string}`) & { readonly __brand: 'HiddenKey' };

const escapePath = (path: string) => path.replace(/%/g, '%25').replace(/#/g, '%23');
const unescapePath = (path: string) => path.replace(/%23/g, '#').replace(/%25/g, '%');

export const fileHiddenKey = (g: Graph, fileId: number): HiddenKey =>
  `file:${escapePath(g.files[fileId]!.path)}` as HiddenKey;
export const fnHiddenKey = (g: Graph, fnId: number): HiddenKey => {
  const fn = g.fns[fnId]!;
  return `fn:${escapePath(g.files[fn.file]!.path)}#${fn.key}` as HiddenKey;
};

/** What a stored key names, for showing an entry whose target no longer exists. */
export function parseHiddenKey(key: HiddenKey): { kind: 'file'; path: string } | { kind: 'fn'; path: string; fn: string } {
  if (key.startsWith('file:')) return { kind: 'file', path: unescapePath(key.slice('file:'.length)) };
  const rest = key.slice('fn:'.length);
  const hash = rest.indexOf('#');
  return { kind: 'fn', path: unescapePath(rest.slice(0, hash)), fn: rest.slice(hash + 1) };
}

export const isHiddenKey = (s: unknown): s is HiddenKey =>
  typeof s === 'string' && (s.startsWith('file:') || (s.startsWith('fn:') && s.includes('#')));

export type HiddenTarget = { kind: 'file'; id: number } | { kind: 'fn'; id: number };

/** Every key in the graph, so stored keys resolve to whatever ids the current index uses. */
export function hiddenKeyIndex(g: Graph): Map<HiddenKey, HiddenTarget> {
  const index = new Map<HiddenKey, HiddenTarget>();
  g.files.forEach((_, id) => index.set(fileHiddenKey(g, id), { kind: 'file', id }));
  g.fns.forEach((_, id) => index.set(fnHiddenKey(g, id), { kind: 'fn', id }));
  return index;
}

/** `[caller, callee, count, via]`. `via` edges stand for a path through contracted private fns. */
export type Edge = readonly [caller: number, callee: number, count: number, via: boolean];

export interface Pruned {
  files: ReadonlySet<number>;
  /** Includes every fn of a hidden file. */
  fns: ReadonlySet<number>;
  edges: Graph['edges'];
}

export function removeUserHidden(
  g: Graph,
  keys: Iterable<HiddenKey>,
  index: ReadonlyMap<HiddenKey, HiddenTarget> = hiddenKeyIndex(g),
): Pruned {
  const files = new Set<number>();
  const fns = new Set<number>();
  for (const key of keys) {
    const t = index.get(key);
    if (!t) continue;
    if (t.kind === 'fn') {
      fns.add(t.id);
      continue;
    }
    files.add(t.id);
    const [start, end] = g.files[t.id]!.fns;
    for (let fn = start; fn < end; fn++) fns.add(fn);
  }
  const edges = fns.size ? g.edges.filter(([a, b]) => !fns.has(a) && !fns.has(b)) : g.edges;
  return { files, fns, edges };
}

/**
 * Private fns outside `showPrivate` that someone calls. Callers are counted in the full graph,
 * so hiding a fn never surfaces its private helpers as new roots. Recursion alone is not a
 * caller: a private fn only its own body calls is still an entry point.
 */
export function hiddenFns(g: Graph, showPrivate: ReadonlySet<number>): Set<number> {
  const called = new Set<number>();
  for (const [caller, callee] of g.edges) if (caller !== callee) called.add(callee);
  const hidden = new Set<number>();
  g.fns.forEach((fn, id) => {
    if (fn.private && !showPrivate.has(fn.file) && called.has(id)) hidden.add(id);
  });
  return hidden;
}

/**
 * Removes the `hidden` fns and routes calls around them. For a visible caller u and hidden
 * callee h, u gets a count-1 via edge to every visible fn reachable from h through hidden fns
 * only, unless u already calls it directly.
 */
export function contract(edges: Graph['edges'], hidden: ReadonlySet<number>): Edge[] {
  const out = new Map<number, [callee: number, count: number][]>();
  for (const [a, b, n] of edges) {
    let list = out.get(a);
    if (!list) out.set(a, (list = []));
    list.push([b, n]);
  }
  const exits = hiddenExits(out, hidden);

  const result: Edge[] = [];
  for (const [u, callees] of out) {
    if (hidden.has(u)) continue;
    const direct = new Set<number>();
    for (const [v, n] of callees) {
      if (hidden.has(v)) continue;
      direct.add(v);
      result.push([u, v, n, false]);
    }
    const via = new Set<number>();
    for (const [h] of callees) {
      if (!hidden.has(h)) continue;
      for (const x of exits(h)) if (x !== u && !direct.has(x)) via.add(x);
    }
    for (const x of via) result.push([u, x, 1, true]);
  }
  return result;
}

// Visible fns reachable from each hidden fn through hidden fns only. Tarjan's algorithm emits
// each strongly connected component after every component it reaches, so one pass fills a
// per-component exit set from successors already done, and hidden cycles terminate.
function hiddenExits(
  out: ReadonlyMap<number, readonly (readonly [number, number])[]>,
  hidden: ReadonlySet<number>,
): (h: number) => ReadonlySet<number> {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccOf = new Map<number, number>();
  const sccExits: Set<number>[] = [];
  let next = 0;

  const hiddenCallees = (v: number) => (out.get(v) ?? []).filter(([w]) => hidden.has(w)).map(([w]) => w);

  for (const root of hidden) {
    if (index.has(root)) continue;
    const frames: { v: number; succ: number[]; i: number }[] = [];
    const enter = (v: number) => {
      index.set(v, next);
      low.set(v, next);
      next++;
      stack.push(v);
      onStack.add(v);
      frames.push({ v, succ: hiddenCallees(v), i: 0 });
    };
    enter(root);
    while (frames.length) {
      const f = frames[frames.length - 1]!;
      if (f.i < f.succ.length) {
        const w = f.succ[f.i++]!;
        if (!index.has(w)) enter(w);
        else if (onStack.has(w)) low.set(f.v, Math.min(low.get(f.v)!, index.get(w)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(f.v)!));
      if (low.get(f.v) !== index.get(f.v)) continue;

      const id = sccExits.length;
      const members: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        sccOf.set(w, id);
        members.push(w);
      } while (w !== f.v);
      const exits = new Set<number>();
      for (const m of members) {
        for (const [x] of out.get(m) ?? []) {
          if (!hidden.has(x)) exits.add(x);
          else if (sccOf.get(x) !== id) for (const e of sccExits[sccOf.get(x)!]!) exits.add(e);
        }
      }
      sccExits.push(exits);
    }
  }
  return (h) => sccExits[sccOf.get(h)!]!;
}

/** What the view draws: nodes that exist and the edges between them. */
export interface Visible {
  /** User-hidden files. They get no node in any mode. */
  hiddenFiles: ReadonlySet<number>;
  /** Fns without a node: user-hidden, or contracted private fns. */
  hiddenFns: ReadonlySet<number>;
  /** Files with fns, none of them visible. They stay as a collapsed node, drawn dimmed. */
  vacant: ReadonlySet<number>;
  edges: Edge[];
}

export function visible(g: Graph, pruned: Pruned, privateHidden: ReadonlySet<number>): Visible {
  const hidden = new Set([...pruned.fns, ...privateHidden]);
  const vacant = new Set<number>();
  g.files.forEach((file, id) => {
    const [start, end] = file.fns;
    if (start === end || pruned.files.has(id)) return;
    for (let fn = start; fn < end; fn++) if (!hidden.has(fn)) return;
    vacant.add(id);
  });
  return { hiddenFiles: pruned.files, hiddenFns: hidden, vacant, edges: contract(pruned.edges, privateHidden) };
}

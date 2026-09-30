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
 * The private fns outside `showPrivate` that get contracted. Such a candidate stays visible as
 * an entry point when no other fn leads into it: nothing outside the candidates reaches it, and
 * it sits in a source component of the candidates nothing else reaches (an uncalled helper, a
 * mutually recursive pair nobody calls). Every other candidate is hidden. Callers count in the
 * full graph, so hiding a module never surfaces its private helpers as new roots.
 */
export function hiddenFns(g: Graph, showPrivate: ReadonlySet<number>): Set<number> {
  const candidate = (id: number) => g.fns[id]!.private && !showPrivate.has(g.fns[id]!.file);
  const out = new Map<number, number[]>();
  for (const [a, b] of g.edges) {
    if (!candidate(b)) continue;
    let list = out.get(a);
    if (!list) out.set(a, (list = []));
    list.push(b);
  }
  const reach = (from: Iterable<number>, into: Set<number>) => {
    const queue = [...from];
    while (queue.length) {
      for (const w of out.get(queue.pop()!) ?? []) {
        if (into.has(w)) continue;
        into.add(w);
        queue.push(w);
      }
    }
  };

  const reached = new Set<number>();
  reach([...out.keys()].filter((v) => !candidate(v)), reached);

  const unreached: number[] = [];
  g.fns.forEach((_, id) => candidate(id) && !reached.has(id) && unreached.push(id));
  const { of, members } = components(unreached, (v) => (out.get(v) ?? []).filter((w) => !reached.has(w)));
  const entered = new Set<number>();
  for (const v of unreached) for (const w of out.get(v) ?? []) if (of.get(w) !== of.get(v)) entered.add(of.get(w)!);
  const entries = members.flatMap((m, c) => (entered.has(c) ? [] : m));

  reach(entries, reached);
  for (const e of entries) reached.delete(e);
  return reached;
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

  // Visible fns reachable from each hidden fn through hidden fns only. Components come out
  // after every component they reach, so one pass fills each exit set from finished successors,
  // and hidden cycles terminate.
  const { of, members } = components(hidden, (v) => (out.get(v) ?? []).filter(([w]) => hidden.has(w)).map(([w]) => w));
  const exits: Set<number>[] = members.map(() => new Set());
  members.forEach((group, c) => {
    for (const m of group) {
      for (const [x] of out.get(m) ?? []) {
        if (!hidden.has(x)) exits[c]!.add(x);
        else if (of.get(x) !== c) for (const e of exits[of.get(x)!]!) exits[c]!.add(e);
      }
    }
  });

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
      for (const x of exits[of.get(h)!]!) if (x !== u && !direct.has(x)) via.add(x);
    }
    for (const x of via) result.push([u, x, 1, true]);
  }
  return result;
}

/**
 * Strongly connected components of the subgraph on `nodes` (Tarjan, iterative). `members` lists
 * them in the order Tarjan finishes them, so each comes after every component it reaches.
 */
function components(
  nodes: Iterable<number>,
  succ: (v: number) => number[],
): { of: Map<number, number>; members: number[][] } {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const of = new Map<number, number>();
  const members: number[][] = [];

  for (const root of nodes) {
    if (index.has(root)) continue;
    const frames: { v: number; succ: number[]; i: number }[] = [];
    const enter = (v: number) => {
      index.set(v, index.size);
      low.set(v, index.get(v)!);
      stack.push(v);
      onStack.add(v);
      frames.push({ v, succ: succ(v), i: 0 });
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

      const group: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        of.set(w, members.length);
        group.push(w);
      } while (w !== f.v);
      members.push(group);
    }
  }
  return { of, members };
}

/** What the view draws: nodes that exist and the edges between them. */
export interface Visible {
  /** User-hidden files. They get no node in any mode. */
  hiddenFiles: ReadonlySet<number>;
  /** Fns without a node: user-hidden, or contracted private fns. */
  hiddenFns: ReadonlySet<number>;
  /** Private fns contracted away. Disjoint from the user-hidden fns. */
  contracted: ReadonlySet<number>;
  /** Files with fns, none of them visible. They stay as a collapsed node, drawn dimmed. */
  vacant: ReadonlySet<number>;
  edges: Edge[];
}

export function visible(g: Graph, pruned: Pruned, showPrivate: ReadonlySet<number>): Visible {
  const contracted = hiddenFns(g, showPrivate);
  for (const fn of pruned.fns) contracted.delete(fn);
  const hidden = new Set([...pruned.fns, ...contracted]);
  const vacant = new Set<number>();
  g.files.forEach((file, id) => {
    const [start, end] = file.fns;
    if (start === end || pruned.files.has(id)) return;
    for (let fn = start; fn < end; fn++) if (!hidden.has(fn)) return;
    vacant.add(id);
  });
  return { hiddenFiles: pruned.files, hiddenFns: hidden, contracted, vacant, edges: contract(pruned.edges, contracted) };
}

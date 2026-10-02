import type { Box } from './labels';

export type Point = readonly [x: number, y: number];

export interface LayoutInput {
  /** Each file to lay out with its visible fns. A file without fns still gets a box. */
  files: ReadonlyMap<number, readonly number[]>;
  /** Calls between the visible fns. */
  edges: Iterable<readonly [caller: number, callee: number]>;
  /** How wide a file's box is, to fit its fn labels. */
  width(file: number): number;
}

export interface Layout {
  /** Each fn's row: the left edge of its file's box, at the row's vertical center. */
  fns: Map<number, Point>;
  boxes: Map<number, Box>;
  /** `caller>callee` for calls drawn against the flow: each closes a cycle some call has to. */
  backward: Set<string>;
}

// Graph units.
export const ROW = 18;
const PAD = 10;
// Between file columns, room for calls to fan out; between stacked boxes, room for a label.
const FILE_GAP = 160;
const STACK_GAP = 30;
const SWEEPS = 6;
// Width over height the layout aims for when its columns would otherwise make it a thin band.
const ASPECT = 1.5;
const SPREAD_SWEEPS = 8;
// How far a box moves from its slot in the even spread toward the rows it connects to.
const PULL = 0.3;

export const edgeKey = (caller: number, callee: number) => `${caller}>${callee}`;

/**
 * Files in columns, so calls between files point right; each file a list of its fns, callers
 * above callees, so calls within a file point down. A call goes against that flow only when it
 * closes a cycle: between files that call each other, or between fns of one file that do.
 */
export function layout({ files, edges, width }: LayoutInput): Layout {
  const fileOf = new Map<number, number>();
  for (const [file, fns] of files) for (const fn of fns) fileOf.set(fn, file);
  const calls = new Map<string, [number, number]>();
  for (const [a, b] of edges) {
    if (a !== b && fileOf.has(a) && fileOf.has(b)) calls.set(edgeKey(a, b), [a, b]);
  }
  const between = new Map<string, [number, number]>();
  const within = new Map<number, [number, number][]>([...files.keys()].map((f) => [f, []]));
  for (const [a, b] of calls.values()) {
    const [fa, fb] = [fileOf.get(a)!, fileOf.get(b)!];
    if (fa === fb) within.get(fa)!.push([a, b]);
    else between.set(edgeKey(fa, fb), [fa, fb]);
  }

  const backward = new Set<string>();
  const lists = new Map<number, number[]>();
  for (const [file, fns] of files) {
    const { order, backward: back } = flow([...fns], within.get(file)!);
    lists.set(file, order);
    for (const key of back) backward.add(key);
  }
  const height = (file: number) => 2 * PAD + Math.max(0, lists.get(file)!.length - 1) * ROW;
  const offset = new Map<number, number>();
  for (const list of lists.values()) list.forEach((fn, i) => offset.set(fn, PAD + i * ROW));
  // Per file, each call to or from another file as [own fn, other fn].
  const ties = new Map<number, [number, number][]>([...files.keys()].map((f) => [f, []]));
  for (const [a, b] of calls.values()) {
    const [fa, fb] = [fileOf.get(a)!, fileOf.get(b)!];
    if (fa === fb) continue;
    ties.get(fa)!.push([a, b]);
    ties.get(fb)!.push([b, a]);
  }

  const outer = columns([...files.keys()], [...between.values()]);
  const xs: number[] = [];
  let x = 0;
  for (const column of outer.columns) {
    xs.push(x);
    x += Math.max(0, ...column.map(width)) + FILE_GAP;
  }
  const stacked = (column: number[]) => column.reduce((sum, f) => sum + height(f), 0) + (column.length - 1) * STACK_GAP;
  // Columns share one height: enough for the tallest stack, and tall enough to keep the layout
  // near ASPECT so it fills a screen rather than a thin band.
  const span = Math.max(...outer.columns.map(stacked), (x - FILE_GAP) / ASPECT);
  const top = new Map<number, number>();
  const slot = new Map<number, number>();
  for (const column of outer.columns) {
    const gap = Math.max(STACK_GAP, (span - stacked(column) + (column.length - 1) * STACK_GAP) / column.length);
    let y = -span / 2 + (gap - STACK_GAP) / 2;
    for (const f of column) {
      slot.set(f, y);
      top.set(f, y);
      y += height(f) + gap;
    }
  }
  // Each box drifts toward the rows it calls or is called by, so calls between files run closer
  // to level, while keeping its place in the column and STACK_GAP from its neighbors. Pulled
  // only by each other, boxes would bunch into a band again, so each stays tied to its slot in
  // the even spread.
  for (let s = 0; s < SPREAD_SWEEPS; s++) {
    const order = s % 2 ? [...outer.columns].reverse() : outer.columns;
    for (const column of order) {
      const want = column.map((f) => {
        const t = ties.get(f)!;
        if (!t.length) return slot.get(f)!;
        const pull = t.reduce((sum, [own, other]) => sum + top.get(fileOf.get(other)!)! + offset.get(other)! - offset.get(own)!, 0) / t.length;
        return lerp(slot.get(f)!, pull, PULL);
      });
      const ys = [...want];
      ys[0] = Math.max(ys[0]!, -span / 2);
      for (let i = 1; i < column.length; i++) ys[i] = Math.max(ys[i]!, ys[i - 1]! + height(column[i - 1]!) + STACK_GAP);
      const last = column.length - 1;
      ys[last] = Math.min(ys[last]!, span / 2 - height(column[last]!));
      for (let i = last - 1; i >= 0; i--) ys[i] = Math.min(ys[i]!, ys[i + 1]! - STACK_GAP - height(column[i]!));
      column.forEach((f, i) => top.set(f, ys[i]!));
    }
  }
  const boxes = new Map<number, Box>();
  outer.columns.forEach((column, c) => {
    for (const f of column) boxes.set(f, { x0: xs[c]!, y0: top.get(f)!, x1: xs[c]! + width(f), y1: top.get(f)! + height(f) });
  });

  const fns = new Map<number, Point>();
  for (const [file, list] of lists) {
    const b = boxes.get(file)!;
    list.forEach((fn, i) => fns.set(fn, [b.x0, b.y0 + PAD + i * ROW]));
  }
  for (const [key, [a, b]] of calls) {
    if (outer.backward.has(edgeKey(fileOf.get(a)!, fileOf.get(b)!))) backward.add(key);
  }
  return { fns, boxes, backward };
}

/**
 * Orders nodes so that as few edges as possible point backward (Eades, Lin and Smyth's greedy
 * heuristic), then lists them topologically along the remaining edges, earliest id first.
 */
function flow(nodes: number[], edges: [number, number][]): { order: number[]; backward: Set<string> } {
  const { preds, succs, backward } = orient(nodes, edges);
  const waiting = new Map(nodes.map((v) => [v, preds.get(v)!.length]));
  const ready = nodes.filter((v) => !waiting.get(v));
  const order: number[] = [];
  while (ready.length) {
    ready.sort((a, b) => b - a);
    const v = ready.pop()!;
    order.push(v);
    for (const w of succs.get(v)!) {
      waiting.set(w, waiting.get(w)! - 1);
      if (!waiting.get(w)) ready.push(w);
    }
  }
  return { order, backward };
}

/**
 * Sugiyama-style columns: the edges oriented as in `flow`, each node one column right of its
 * furthest predecessor, and each column ordered by barycenter sweeps to keep edges from crossing.
 */
function columns(nodes: number[], edges: [number, number][]): { columns: number[][]; backward: Set<string> } {
  const { preds, succs, backward, rank } = orient(nodes, edges);
  const order = [...nodes].sort((a, b) => rank.get(a)! - rank.get(b)!);
  const layer = new Map<number, number>();
  for (const v of order) layer.set(v, Math.max(0, ...preds.get(v)!.map((u) => layer.get(u)! + 1)));
  // A node with no predecessor moves right to sit just before its nearest successor.
  for (const v of [...order].reverse()) {
    if (preds.get(v)!.length || !succs.get(v)!.length) continue;
    layer.set(v, Math.min(...succs.get(v)!.map((w) => layer.get(w)!)) - 1);
  }

  const cols: number[][] = [];
  for (const v of [...nodes].sort((a, b) => a - b)) (cols[layer.get(v)!] ??= []).push(v);
  const filled = Array.from(cols, (c) => c ?? []).filter((c) => c.length);
  // Rightward sweeps order a column by its predecessors' positions, leftward by its successors'.
  for (let s = 0; s < SWEEPS; s++) {
    const rightward = s % 2 === 0;
    const near = rightward ? preds : succs;
    for (let i = 0; i < filled.length; i++) {
      const column = filled[rightward ? i : filled.length - 1 - i]!;
      const pos = new Map<number, number>();
      for (const c of filled) c.forEach((v, j) => pos.set(v, j / Math.max(1, c.length - 1)));
      const key = new Map(
        column.map((v) => {
          const ns = near.get(v)!;
          return [v, ns.length ? ns.reduce((sum, n) => sum + pos.get(n)!, 0) / ns.length : pos.get(v)!];
        }),
      );
      column.sort((a, b) => key.get(a)! - key.get(b)! || a - b);
    }
  }
  return { columns: filled, backward };
}

/** The edges with the few that close cycles turned around, as adjacency lists. */
function orient(nodes: number[], edges: [number, number][]) {
  const rank = feedbackOrder(nodes, edges);
  const backward = new Set<string>();
  const preds = new Map<number, number[]>(nodes.map((v) => [v, []]));
  const succs = new Map<number, number[]>(nodes.map((v) => [v, []]));
  for (const [a, b] of edges) {
    const [u, w] = rank.get(a)! < rank.get(b)! ? [a, b] : (backward.add(edgeKey(a, b)), [b, a]);
    succs.get(u)!.push(w);
    preds.get(w)!.push(u);
  }
  return { rank, preds, succs, backward };
}

/** An order that as few edges as possible run against. On an acyclic graph, none do. */
function feedbackOrder(nodes: number[], edges: [number, number][]): Map<number, number> {
  const out = new Map<number, Set<number>>(nodes.map((v) => [v, new Set()]));
  const inn = new Map<number, Set<number>>(nodes.map((v) => [v, new Set()]));
  for (const [a, b] of edges) {
    out.get(a)!.add(b);
    inn.get(b)!.add(a);
  }
  const alive = new Set([...nodes].sort((a, b) => a - b));
  const head: number[] = [];
  const tail: number[] = [];
  const remove = (v: number) => {
    alive.delete(v);
    for (const w of out.get(v)!) inn.get(w)!.delete(v);
    for (const w of inn.get(v)!) out.get(w)!.delete(v);
  };
  while (alive.size) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const v of [...alive]) {
        if (out.get(v)!.size === 0) tail.push(v);
        else if (inn.get(v)!.size === 0) head.push(v);
        else continue;
        remove(v);
        changed = true;
      }
    }
    if (!alive.size) break;
    let best = -1;
    let score = -Infinity;
    for (const v of alive) {
      const s = out.get(v)!.size - inn.get(v)!.size;
      if (s > score) [best, score] = [v, s];
    }
    head.push(best);
    remove(best);
  }
  return new Map([...head, ...tail.reverse()].map((v, i) => [v, i]));
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

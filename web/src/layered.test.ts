import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { edgeKey, layout, type Layout, type LayoutInput } from './layered';
import type { Graph } from './types';
import { removeUserHidden, visible } from './visibility';

const mini: Graph = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/mini.graph.json'), 'utf8'),
);

const width = () => 200;

function input(files: Record<number, number[]>, edges: [number, number][]): LayoutInput {
  return { files: new Map(Object.entries(files).map(([f, fns]) => [Number(f), fns])), edges, width };
}

/**
 * Calls drawn against the flow: between files, a callee's box not wholly right of the caller's;
 * within a file, a callee not below its caller.
 */
function against(l: Layout, files: LayoutInput['files'], edges: Iterable<readonly [number, number]>): string[] {
  const fileOf = new Map<number, number>();
  for (const [file, fns] of files) for (const fn of fns) fileOf.set(fn, file);
  const out: string[] = [];
  for (const [a, b] of edges) {
    if (a === b) continue;
    const [fa, fb] = [fileOf.get(a)!, fileOf.get(b)!];
    const ok = fa === fb ? l.fns.get(b)![1] > l.fns.get(a)![1] : l.boxes.get(fb)!.x0 > l.boxes.get(fa)!.x1;
    if (!ok) out.push(edgeKey(a, b));
  }
  return out.sort();
}

function expectTidy(l: Layout, files: LayoutInput['files']) {
  const boxes = [...l.boxes.values()];
  boxes.forEach((a, i) =>
    boxes.slice(i + 1).forEach((b) => {
      expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0).toBe(true);
    }),
  );
  for (const [file, fns] of files) {
    const box = l.boxes.get(file)!;
    for (const fn of fns) {
      const [x, y] = l.fns.get(fn)!;
      expect(x === box.x0 && y > box.y0 && y < box.y1).toBe(true);
    }
  }
  const seen = new Set([...l.fns.values()].map(([x, y]) => `${x},${y}`));
  expect(seen.size).toBe(l.fns.size);
}

describe('layout', () => {
  it('points calls between files right and calls within a file down when nothing cycles', () => {
    const edges: [number, number][] = [
      [0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [0, 4], [5, 4], [1, 5],
    ];
    const files = input({ 0: [0, 1, 5], 1: [2, 3], 2: [4] }, edges);
    const l = layout(files);
    expect(against(l, files.files, edges)).toEqual([]);
    expect(l.backward.size).toBe(0);
    expectTidy(l, files.files);
  });

  it('turns calls around only between files that call each other, and reports them', () => {
    // Acyclic between fns, but file 0 calls file 1 and file 1 calls file 0.
    const edges: [number, number][] = [[0, 2], [2, 1], [1, 3]];
    const files = input({ 0: [0, 1], 1: [2, 3] }, edges);
    const l = layout(files);
    const left = against(l, files.files, edges);
    expect(left).toHaveLength(1);
    expect([...l.backward].sort()).toEqual(left);
  });

  it('turns one call of a cycle within a file around', () => {
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 0], [2, 3]];
    const files = input({ 0: [0, 1, 2, 3] }, edges);
    const l = layout(files);
    const left = against(l, files.files, edges);
    expect(left).toHaveLength(1);
    expect([...l.backward]).toEqual(left);
  });

  it('lists a file in source order where its calls leave a choice', () => {
    const edges: [number, number][] = [[4, 1]];
    const l = layout(input({ 0: [0, 1, 2, 3, 4] }, edges));
    const rows = [0, 1, 2, 3, 4].sort((a, b) => l.fns.get(a)![1] - l.fns.get(b)![1]);
    expect(rows).toEqual([0, 2, 3, 4, 1]);
  });

  it('puts a file right of every file it calls into', () => {
    const files = input({ 0: [0], 1: [1], 2: [2] }, [[0, 1], [1, 2], [0, 2]]);
    const l = layout(files);
    const x = (f: number) => l.boxes.get(f)!.x0;
    expect(x(0) < x(1) && x(1) < x(2)).toBe(true);
  });

  it('gives a file without visible fns its own box', () => {
    const files = input({ 0: [0, 1], 1: [] }, [[0, 1]]);
    const l = layout(files);
    expect(l.boxes.has(1)).toBe(true);
    expectTidy(l, files.files);
  });

  it('lays out the mini fixture with only reported calls pointing left and tidy boxes', () => {
    const v = visible(mini, removeUserHidden(mini, []), new Set(mini.files.keys()));
    const files = new Map<number, number[]>();
    mini.files.forEach((f, id) => {
      const fns: number[] = [];
      for (let fn = f.fns[0]; fn < f.fns[1]; fn++) if (!v.hiddenFns.has(fn)) fns.push(fn);
      if (f.fns[1] > f.fns[0]) files.set(id, fns);
    });
    const edges = v.edges.map(([a, b]) => [a, b] as const);
    const l = layout({ files, edges, width });
    expect(against(l, files, edges)).toEqual([...l.backward].sort());
    expectTidy(l, files);
  });

  it('is deterministic', () => {
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 0], [3, 1]];
    const files = input({ 0: [0, 3], 1: [1, 2] }, edges);
    expect(layout(files)).toEqual(layout(files));
  });
});

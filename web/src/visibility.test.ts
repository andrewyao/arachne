import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveExpanded, project, type NodeKey, type View } from './project';
import type { FnNode, Graph } from './types';
import {
  contract,
  fileHiddenKey,
  fnHiddenKey,
  parseHiddenKey,
  removeUserHidden,
  visible,
  type HiddenKey,
} from './visibility';

const mini: Graph = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/mini.graph.json'), 'utf8'),
);

// Builds a graph from `{ path: [[label, private, key?]] }`. Calls name fns by label.
function build(files: Record<string, [label: string, priv: boolean, key?: string][]>, calls: [string, string, number?][]): Graph {
  const g: Graph = { project: '/p', files: [], fns: [], edges: [] };
  for (const [path, fns] of Object.entries(files)) {
    const file = g.files.length;
    const start = g.fns.length;
    for (const [label, priv, key = `${label}().`] of fns) {
      g.fns.push({ file, label, key, kind: 'free', lines: [1, 1], private: priv } satisfies FnNode);
    }
    g.files.push({ path, label: path, fns: [start, g.fns.length] });
  }
  const id = (label: string) => g.fns.findIndex((f) => f.label === label);
  g.edges = calls.map(([a, b, n = 1]) => [id(a), id(b), n]);
  return g;
}

function render(
  g: Graph,
  { hide = [], showPrivate = [], expanded = 'all' }: { hide?: HiddenKey[]; showPrivate?: number[]; expanded?: 'all' | number[] },
): View {
  const v = visible(g, removeUserHidden(g, hide), new Set(showPrivate));
  const open = expanded === 'all' ? effectiveExpanded('all', new Set(), g.files.length) : new Set(expanded);
  return project(g, v, open);
}

// `->` is a direct call, `=>` a call routed through contracted private fns.
function edges(g: Graph, view: View): string[] {
  const name = (k: NodeKey) => {
    const [kind, id] = k.split(':') as ['file' | 'fn', string];
    return kind === 'fn' ? g.fns[+id]!.label : `[${g.files[+id]!.label}]`;
  };
  return view.links.map((l) => `${name(l.source)} ${l.via ? '=>' : '->'} ${name(l.target)} x${l.count}`).sort();
}
const nodes = (g: Graph, view: View) =>
  view.nodes.map((n) => (n.kind === 'fn' ? g.fns[n.id]!.label : `[${g.files[n.id]!.label}]`)).sort();

describe('private fn contraction', () => {
  it('turns A -> B -> private C -> private D -> E into A -> B => E', () => {
    const view = render(mini, { expanded: [6] });
    const vis = (s: string) => s.includes('vis.');
    expect(nodes(mini, view).filter(vis)).toEqual(['vis.entry', 'vis.relay', 'vis.sink']);
    expect(edges(mini, view).filter(vis)).toEqual(
      ['[app] -> vis.entry x1', 'vis.entry -> vis.relay x1', 'vis.relay => vis.sink x1', 'vis.sink -> [db/util] x1'].sort(),
    );
  });

  it('terminates on a hidden cycle and still reaches the exit', () => {
    const g = build(
      { m: [['A', false], ['B', false], ['C', true], ['D', true], ['E', false]] },
      [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'C'], ['D', 'E']],
    );
    expect(edges(g, render(g, {}))).toEqual(['A -> B x1', 'B => E x1']);
  });

  it('keeps an uncalled private fn and contracts its calls through hidden fns', () => {
    const g = build(
      { m: [['main', true], ['helper', true], ['E', false], ['rec', true]] },
      [['main', 'helper'], ['helper', 'E'], ['rec', 'rec'], ['rec', 'E']],
    );
    const view = render(g, {});
    expect(nodes(g, view)).toEqual(['E', 'main', 'rec']);
    expect(edges(g, view)).toEqual(['main => E x1', 'rec -> E x1']);
    expect(nodes(mini, render(mini, {}))).toContain('app.main');
  });

  it('keeps a private cycle nobody else calls visible, with its calls out', () => {
    const g = build(
      { m: [['even', true], ['odd', true], ['E', false], ['lone', true]] },
      [['even', 'odd'], ['odd', 'even'], ['odd', 'E']],
    );
    const view = render(g, {});
    expect(nodes(g, view)).toEqual(['E', 'even', 'lone', 'odd']);
    expect(edges(g, view)).toEqual(['even -> odd x1', 'odd -> E x1', 'odd -> even x1']);
  });

  it('contracts a private cycle that an uncalled private entry point reaches', () => {
    const g = build(
      { m: [['main', true], ['C', true], ['D', true], ['E', false]] },
      [['main', 'C'], ['C', 'D'], ['D', 'C'], ['D', 'E']],
    );
    const view = render(g, {});
    expect(nodes(g, view)).toEqual(['E', 'main']);
    expect(edges(g, view)).toEqual(['main => E x1']);
  });

  it('keeps hiding a private helper whose only caller the user hid', () => {
    const g = build({ m: [['A', false], ['helper', true], ['E', false]] }, [['A', 'helper'], ['helper', 'E']]);
    const view = render(g, { hide: [fnHiddenKey(g, 0)] });
    expect(nodes(g, view)).toEqual(['E']);
    expect(edges(g, view)).toEqual([]);
  });

  it('shows the private fns of one file and keeps contracting the rest', () => {
    const split = build(
      { a: [['B', false], ['C', true]], b: [['D', true], ['E', false]] },
      [['B', 'C'], ['C', 'D'], ['D', 'E']],
    );
    expect(edges(split, render(split, {}))).toEqual(['B => E x1']);
    expect(edges(split, render(split, { showPrivate: [0] }))).toEqual(['B -> C x1', 'C => E x1']);

    const vis = (s: string) => s.includes('vis.');
    expect(edges(mini, render(mini, { showPrivate: [6], expanded: [6] })).filter(vis)).toEqual(
      [
        '[app] -> vis.entry x1',
        'vis.entry -> vis.relay x1',
        'vis.relay -> vis.hop x1',
        'vis.hop -> vis.Hop::step x1',
        'vis.Hop::step -> vis.sink x1',
        'vis.sink -> [db/util] x1',
      ].sort(),
    );
  });

  it('keeps a direct call and its count over a contracted path to the same fn', () => {
    const g = build(
      { m: [['B', false], ['C', true], ['E', false], ['F', false]] },
      [['B', 'C'], ['B', 'E', 3], ['C', 'E'], ['C', 'F']],
    );
    expect(edges(g, render(g, {}))).toEqual(['B -> E x3', 'B => F x1']);
  });

  it('draws a collapsed link with any direct call solid, with only the direct count', () => {
    for (const calls of [
      [['A2', 'F', 2], ['A', 'C'], ['C', 'E']],
      [['A', 'C'], ['C', 'E'], ['A2', 'F', 2]],
    ] as [string, string, number?][][]) {
      const g = build({ a: [['A', false], ['A2', false], ['C', true]], b: [['E', false], ['F', false]] }, calls);
      expect(edges(g, render(g, { expanded: [] }))).toEqual(['[a] -> [b] x2']);
    }
  });

  it('draws a collapsed link dashed when every call it aggregates is via, counting the via edges', () => {
    const g = build(
      { a: [['A', false], ['A2', false], ['C', true]], b: [['E', false], ['F', false]] },
      [['A', 'C'], ['A2', 'C'], ['C', 'E'], ['C', 'F']],
    );
    expect(edges(g, render(g, { expanded: [] }))).toEqual(['[a] => [b] x4']);
  });

  it('agrees with a breadth-first search through hidden fns on random graphs', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return Math.floor(seed / 65536) % n;
    };
    for (let round = 0; round < 200; round++) {
      const n = 3 + rand(25);
      const hidden = new Set<number>();
      for (let i = 0; i < n; i++) if (rand(2)) hidden.add(i);
      const pairs = new Map<string, [number, number, number]>();
      for (let k = rand(3 * n); k > 0; k--) {
        const a = rand(n);
        const b = rand(n);
        pairs.set(`${a}>${b}`, [a, b, 1 + rand(3)]);
      }
      const graphEdges = [...pairs.values()];

      const want: string[] = [];
      for (let u = 0; u < n; u++) {
        if (hidden.has(u)) continue;
        const direct = new Set(graphEdges.filter(([a, b]) => a === u && !hidden.has(b)).map(([, b]) => b));
        for (const [a, b, c] of graphEdges) if (a === u && !hidden.has(b)) want.push(`${u}>${b}x${c}`);
        const seen = new Set<number>();
        const queue = graphEdges.filter(([a, b]) => a === u && hidden.has(b)).map(([, b]) => b);
        const exits = new Set<number>();
        while (queue.length) {
          const h = queue.shift()!;
          if (seen.has(h)) continue;
          seen.add(h);
          for (const [a, b] of graphEdges) {
            if (a !== h) continue;
            if (hidden.has(b)) queue.push(b);
            else exits.add(b);
          }
        }
        for (const x of exits) if (x !== u && !direct.has(x)) want.push(`${u}=>${x}x1`);
      }
      const got = contract(graphEdges, hidden).map(([a, b, c, via]) => `${a}${via ? '=>' : '>'}${b}x${c}`);
      expect(got.sort()).toEqual(want.sort());
    }
  });

  it('keeps a file whose fns are all hidden as a collapsed, vacant node, even when expanded', () => {
    const g = build({ a: [['A', false]], b: [['C', true]] }, [['A', 'C']]);
    const v = visible(g, removeUserHidden(g, []), new Set());
    expect([...v.vacant]).toEqual([1]);
    expect(nodes(g, project(g, v, new Set([0, 1])))).toEqual(['A', '[b]']);
  });
});

describe('user hidden list', () => {
  it('drops a hidden fn and every edge touching it, with no shortcut', () => {
    const hop = fnHiddenKey(mini, 16);
    expect(hop).toBe('fn:app/src/vis.rs#vis/hop().');
    const view = render(mini, { hide: [hop], showPrivate: [6], expanded: [6] });
    const vis = (s: string) => s.includes('vis.');
    expect(nodes(mini, view).filter(vis)).toEqual(['vis.Hop::step', 'vis.entry', 'vis.relay', 'vis.sink'].sort());
    expect(edges(mini, view).filter(vis)).toEqual(
      ['[app] -> vis.entry x1', 'vis.entry -> vis.relay x1', 'vis.Hop::step -> vis.sink x1', 'vis.sink -> [db/util] x1'].sort(),
    );
  });

  it('drops a hidden file and all its fns, in manual and Expand All modes', () => {
    const vis = fileHiddenKey(mini, 6);
    expect(vis).toBe('file:app/src/vis.rs');
    for (const expanded of [[], [6], 'all'] as const) {
      const view = render(mini, { hide: [vis], expanded: expanded === 'all' ? 'all' : [...expanded] });
      expect(nodes(mini, view).filter((n) => n.includes('vis'))).toEqual([]);
      expect(edges(mini, view).filter((e) => e.includes('vis'))).toEqual([]);
    }
  });

  it('finds the same node by key after the ids shift', () => {
    const key = fnHiddenKey(mini, 18);
    const shifted: Graph = build(
      { 'app/src/aaa.rs': [['aaa.first', false], ['aaa.second', false]] },
      [],
    );
    const offset = shifted.fns.length;
    shifted.files.push(...mini.files.map((f) => ({ ...f, fns: [f.fns[0] + offset, f.fns[1] + offset] as [number, number] })));
    shifted.fns.push(...mini.fns.map((f) => ({ ...f, file: f.file + 1 })));
    shifted.edges = mini.edges.map(([a, b, n]) => [a + offset, b + offset, n]);

    const pruned = removeUserHidden(shifted, [key]);
    expect([...pruned.fns].map((id) => shifted.fns[id]!.label)).toEqual(['vis.sink']);
    expect([...pruned.fns]).toEqual([18 + offset]);
  });

  it('hides two fns with the same label in one file independently', () => {
    const g = build({ m: [['m.open', false, 'open().'], ['m.open', false, 'open().#2'], ['m.close', false]] }, []);
    expect(fnHiddenKey(g, 0)).not.toBe(fnHiddenKey(g, 1));
    expect([...removeUserHidden(g, [fnHiddenKey(g, 1)]).fns]).toEqual([1]);
    expect([...removeUserHidden(g, [fnHiddenKey(g, 0)]).fns]).toEqual([0]);
  });

  it('keeps a fn key when an unrelated new file forces its label to change', () => {
    const before = build({ 'src/ui/util.rs': [['util.fmt', false, 'ui/util/fmt().']] }, []);
    const after = build(
      { 'src/db/util.rs': [['db/util.fmt', false, 'db/util/fmt().']], 'src/ui/util.rs': [['ui/util.fmt', false, 'ui/util/fmt().']] },
      [],
    );
    const key = fnHiddenKey(before, 0);
    expect([...removeUserHidden(after, [key]).fns].map((id) => after.fns[id]!.label)).toEqual(['ui/util.fmt']);
  });

  it('keeps keys unambiguous when a path contains #', () => {
    const g = build({ 'a.rs': [['a.x', false, 'b.rs#k']], 'a.rs#b.rs': [['ab.k', false, 'k']] }, []);
    expect(fnHiddenKey(g, 0)).not.toBe(fnHiddenKey(g, 1));
    expect([...removeUserHidden(g, [fnHiddenKey(g, 1)]).fns]).toEqual([1]);
    expect(parseHiddenKey(fnHiddenKey(g, 1))).toEqual({ kind: 'fn', path: 'a.rs#b.rs', fn: 'k' });
    expect(parseHiddenKey(fileHiddenKey(g, 1))).toEqual({ kind: 'file', path: 'a.rs#b.rs' });
  });

  it('applies the hidden list before contraction, so no shortcut runs through a hidden fn', () => {
    const g = build(
      { m: [['A', false], ['C', true], ['D', false], ['E', false]] },
      [['A', 'C'], ['C', 'D'], ['D', 'E']],
    );
    const view = render(g, { hide: [fnHiddenKey(g, 2)] });
    expect(nodes(g, view)).toEqual(['A', 'E']);
    expect(edges(g, view)).toEqual([]);
  });

  it('ignores a stored key that no longer names anything', () => {
    const pruned = removeUserHidden(mini, ['file:app/src/gone.rs' as HiddenKey, 'fn:app/src/vis.rs#vis/gone().' as HiddenKey]);
    expect(pruned.fns.size + pruned.files.size).toBe(0);
    expect(pruned.edges).toEqual(mini.edges);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveExpanded, project, type View } from './project';
import type { Graph } from './types';

const mini: Graph = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/mini.graph.json'), 'utf8'),
);

// Files: 0 album, 1 db/util, 2 app, 3 shapes, 4 ui, 5 ui/util.
const links = (v: View) => v.links.map((l) => `${l.source} > ${l.target} x${l.count}`).sort();
const keys = (v: View) => v.nodes.map((n) => n.key).sort();

describe('project on the mini fixture', () => {
  it('aggregates fn calls into file-to-file weights when everything is collapsed', () => {
    const v = project(mini, new Set());
    expect(keys(v)).toEqual(
      ['file:0', 'file:1', 'file:2', 'file:3', 'file:4', 'file:5'].sort(),
    );
    expect(links(v)).toEqual(
      [
        'file:2 > file:0 x2',
        'file:2 > file:1 x1',
        'file:2 > file:3 x1',
        'file:2 > file:4 x1',
        'file:4 > file:5 x1',
      ].sort(),
    );
  });

  it('drops intra-file self-loops while collapsed', () => {
    const v = project(mini, new Set());
    expect(v.links.filter((l) => l.source === l.target)).toEqual([]);
    expect(links(v).filter((l) => l.startsWith('file:3 > file:3'))).toEqual([]);
  });

  it('expands only the requested file, leaving the others collapsed', () => {
    const v = project(mini, new Set([4]));
    expect(keys(v)).toEqual(
      [
        'file:0', 'file:1', 'file:2', 'file:3', 'file:5',
        'fn:11', 'fn:12',
      ].sort(),
    );
    expect(links(v)).toEqual(
      [
        'file:2 > file:0 x2',
        'file:2 > file:1 x1',
        'file:2 > file:3 x1',
        'file:2 > fn:11 x1',
        'fn:11 > fn:12 x1',
        'fn:11 > file:5 x1',
      ].sort(),
    );
  });

  it('shows internal edges of an expanded file', () => {
    const v = project(mini, new Set([3]));
    expect(links(v).filter((l) => /^fn:\d+ > fn:/.test(l))).toEqual(
      [
        'fn:5 > fn:7 x1',
        'fn:5 > fn:8 x1',
        'fn:6 > fn:5 x1',
        'fn:6 > fn:9 x1',
        'fn:10 > fn:6 x1',
        'fn:10 > fn:7 x1',
      ].sort(),
    );
  });

  it('never makes a node for a file without fns', () => {
    const g: Graph = {
      ...mini,
      files: [...mini.files, { path: 'app/src/db/mod.rs', label: 'db', fns: [14, 14] }],
    };
    expect(keys(project(g, new Set())).includes('file:6')).toBe(false);
    expect(keys(project(g, new Set([6]))).includes('file:6')).toBe(false);
  });
});

describe('effectiveExpanded', () => {
  it('expands everything in all mode and restores only the manual picks after', () => {
    const manual = new Set([4]);
    const fnKeys = (v: View) => v.nodes.filter((n) => n.kind === 'fn').map((n) => n.key).sort();

    const before = project(mini, effectiveExpanded('manual', manual, mini.files.length));
    expect(fnKeys(before)).toEqual(['fn:11', 'fn:12']);

    const all = project(mini, effectiveExpanded('all', manual, mini.files.length));
    expect(all.nodes.some((n) => n.kind === 'file')).toBe(false);
    expect(fnKeys(all)).toHaveLength(mini.fns.length);
    expect([...manual]).toEqual([4]);

    const after = project(mini, effectiveExpanded('manual', manual, mini.files.length));
    expect(keys(after)).toEqual(keys(before));
    expect([...manual]).toEqual([4]);
  });
});

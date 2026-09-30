import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { project, type View } from './project';
import type { Graph } from './types';

const mini: Graph = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/mini.graph.json'), 'utf8'),
);

// Files: 0 album, 1 db/util, 2 app, 3 shapes, 4 ui, 5 ui/util. Crates: 0 rawish, 1 std.
const links = (v: View) => v.links.map((l) => `${l.source} > ${l.target} x${l.count}`).sort();
const keys = (v: View) => v.nodes.map((n) => n.key).sort();

describe('project on the mini fixture', () => {
  it('aggregates fn calls into file-to-file weights when everything is collapsed', () => {
    const v = project(mini, new Set());
    expect(keys(v)).toEqual(
      ['crate:0', 'crate:1', 'file:0', 'file:1', 'file:2', 'file:3', 'file:4', 'file:5'].sort(),
    );
    expect(links(v)).toEqual(
      [
        'file:0 > crate:0 x1',
        'file:1 > crate:1 x1',
        'file:2 > file:0 x2',
        'file:2 > file:1 x1',
        'file:2 > file:3 x1',
        'file:2 > file:4 x1',
        'file:3 > crate:1 x3',
        'file:4 > crate:1 x3',
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
        'crate:0', 'crate:1',
        'file:0', 'file:1', 'file:2', 'file:3', 'file:5',
        'fn:11', 'fn:12', 'fn:13',
      ].sort(),
    );
    expect(links(v)).toEqual(
      [
        'file:0 > crate:0 x1',
        'file:1 > crate:1 x1',
        'file:2 > file:0 x2',
        'file:2 > file:1 x1',
        'file:2 > file:3 x1',
        'file:2 > fn:11 x1',
        'file:3 > crate:1 x3',
        'fn:11 > crate:1 x2',
        'fn:11 > fn:12 x1',
        'fn:11 > fn:13 x1',
        'fn:12 > crate:1 x1',
        'fn:12 > file:5 x1',
      ].sort(),
    );
  });

  it('keeps crate endpoints as crate nodes regardless of expansion', () => {
    const everything = new Set(mini.files.map((_, i) => i));
    const v = project(mini, everything);
    expect(v.nodes.filter((n) => n.kind === 'crate').map((n) => n.key)).toEqual([
      'crate:0',
      'crate:1',
    ]);
    expect(v.nodes.some((n) => n.kind === 'file')).toBe(false);
    expect(links(v).filter((l) => l.includes('crate'))).toEqual(
      [
        'fn:1 > crate:0 x1',
        'fn:3 > crate:1 x1',
        'fn:9 > crate:1 x1',
        'fn:10 > crate:1 x2',
        'fn:11 > crate:1 x2',
        'fn:12 > crate:1 x1',
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
      files: [...mini.files, { path: 'app/src/db/mod.rs', label: 'db', fns: [15, 15] }],
    };
    expect(keys(project(g, new Set())).includes('file:6')).toBe(false);
    expect(keys(project(g, new Set([6]))).includes('file:6')).toBe(false);
  });
});

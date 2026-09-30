// Wire format of GET /api/graph. Mirrors src/wire.rs.
// Endpoint ids share one index space: fns are 0..fns.length, crates follow.

export type FnKind = 'free' | 'method' | 'trait_decl' | 'trait_impl' | 'closure' | 'nested';

export interface FileNode {
  path: string;
  label: string;
  fns: [start: number, end: number];
}

export interface FnNode {
  file: number;
  label: string;
  kind: FnKind;
  lines: [start: number, end: number];
}

export interface CrateNode {
  name: string;
}

export interface Graph {
  files: FileNode[];
  fns: FnNode[];
  crates: CrateNode[];
  edges: [caller: number, callee: number, count: number][];
}

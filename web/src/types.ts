// Wire format of GET /api/graph. Mirrors src/wire.rs.
// Edge endpoints are fn ids in 0..fns.length.

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

export interface Graph {
  files: FileNode[];
  fns: FnNode[];
  edges: [caller: number, callee: number, count: number][];
}

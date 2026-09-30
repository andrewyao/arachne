import type { Graph } from './types';

export type NodeKey = `file:${number}` | `fn:${number}` | `crate:${number}`;

export type ViewNode =
  | { kind: 'file'; key: `file:${number}`; id: number }
  | { kind: 'fn'; key: `fn:${number}`; id: number }
  | { kind: 'crate'; key: `crate:${number}`; id: number };

export interface ViewLink {
  source: NodeKey;
  target: NodeKey;
  count: number;
}

export interface View {
  nodes: ViewNode[];
  links: ViewLink[];
}

export const fileKey = (id: number): `file:${number}` => `file:${id}`;
export const fnKey = (id: number): `fn:${number}` => `fn:${id}`;
export const crateKey = (id: number): `crate:${number}` => `crate:${id}`;

export function project(g: Graph, expanded: ReadonlySet<number>): View {
  const nodes: ViewNode[] = [];
  g.files.forEach((file, fileId) => {
    const [start, end] = file.fns;
    if (start === end) return;
    if (!expanded.has(fileId)) {
      nodes.push({ kind: 'file', key: fileKey(fileId), id: fileId });
      return;
    }
    for (let fn = start; fn < end; fn++) nodes.push({ kind: 'fn', key: fnKey(fn), id: fn });
  });
  g.crates.forEach((_, id) => nodes.push({ kind: 'crate', key: crateKey(id), id }));

  const fnCount = g.fns.length;
  const endpoint = (e: number): NodeKey => {
    if (e >= fnCount) return crateKey(e - fnCount);
    const file = g.fns[e]!.file;
    return expanded.has(file) ? fnKey(e) : fileKey(file);
  };

  const counts = new Map<string, ViewLink>();
  for (const [caller, callee, count] of g.edges) {
    const source = endpoint(caller);
    const target = endpoint(callee);
    if (source === target) continue;
    const pair = `${source}>${target}`;
    const link = counts.get(pair);
    if (link) link.count += count;
    else counts.set(pair, { source, target, count });
  }
  return { nodes, links: [...counts.values()] };
}

import type { Graph } from './types';
import type { Visible } from './visibility';

export type NodeKey = `file:${number}` | `fn:${number}`;

export type ViewNode =
  | { kind: 'file'; key: `file:${number}`; id: number }
  | { kind: 'fn'; key: `fn:${number}`; id: number };

export interface ViewLink {
  source: NodeKey;
  target: NodeKey;
  count: number;
  /** Some call it aggregates runs through contracted private fns. */
  via: boolean;
}

export interface View {
  nodes: ViewNode[];
  links: ViewLink[];
}

export const fileKey = (id: number): `file:${number}` => `file:${id}`;
export const fnKey = (id: number): `fn:${number}` => `fn:${id}`;

export type ExpandMode = 'manual' | 'all';

export function effectiveExpanded(
  mode: ExpandMode,
  manual: ReadonlySet<number>,
  fileCount: number,
): ReadonlySet<number> {
  return mode === 'all' ? new Set(Array.from({ length: fileCount }, (_, i) => i)) : manual;
}

/** The expanded files drawn as their fns. A vacant or hidden file has no fn to draw. */
export function openFiles(v: Visible, expanded: ReadonlySet<number>): Set<number> {
  const open = new Set<number>();
  for (const f of expanded) if (!v.vacant.has(f) && !v.hiddenFiles.has(f)) open.add(f);
  return open;
}

export function project(g: Graph, v: Visible, expanded: ReadonlySet<number>): View {
  const open = openFiles(v, expanded);
  const nodes: ViewNode[] = [];
  g.files.forEach((file, fileId) => {
    const [start, end] = file.fns;
    if (start === end || v.hiddenFiles.has(fileId)) return;
    if (!open.has(fileId)) {
      nodes.push({ kind: 'file', key: fileKey(fileId), id: fileId });
      return;
    }
    for (let fn = start; fn < end; fn++) {
      if (!v.hiddenFns.has(fn)) nodes.push({ kind: 'fn', key: fnKey(fn), id: fn });
    }
  });

  const endpoint = (e: number): NodeKey => {
    const file = g.fns[e]!.file;
    return open.has(file) ? fnKey(e) : fileKey(file);
  };

  const links = new Map<string, ViewLink>();
  for (const [caller, callee, count, via] of v.edges) {
    const source = endpoint(caller);
    const target = endpoint(callee);
    if (source === target) continue;
    const pair = `${source}>${target}`;
    const link = links.get(pair);
    if (!link) links.set(pair, { source, target, count, via });
    else {
      link.count += count;
      link.via ||= via;
    }
  }
  return { nodes, links: [...links.values()] };
}

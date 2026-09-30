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

  // Direct calls win: a link counts only its direct calls when it has any, and is drawn as
  // via only when every call it aggregates runs through contracted fns.
  const links = new Map<string, { source: NodeKey; target: NodeKey; direct: number; via: number }>();
  for (const [caller, callee, count, via] of v.edges) {
    const source = endpoint(caller);
    const target = endpoint(callee);
    if (source === target) continue;
    const pair = `${source}>${target}`;
    let link = links.get(pair);
    if (!link) links.set(pair, (link = { source, target, direct: 0, via: 0 }));
    if (via) link.via += count;
    else link.direct += count;
  }
  return {
    nodes,
    links: [...links.values()].map(({ source, target, direct, via }) =>
      direct ? { source, target, count: direct, via: false } : { source, target, count: via, via: true },
    ),
  };
}

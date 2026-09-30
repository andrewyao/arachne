import ForceGraph from 'force-graph';
import { fileKey, fnKey, project, type NodeKey, type ViewNode } from './project';
import type { Graph } from './types';

type SimNode = ViewNode & { x?: number; y?: number; vx?: number; vy?: number; r: number };
type SimLink = { source: NodeKey | SimNode; target: NodeKey | SimNode; count: number };
type Point = readonly [x: number, y: number];

interface Theme {
  ink: string;
  inkSoft: string;
  file: string;
  fn: string;
  crate: string;
  link: string;
  linkHot: string;
  linkDim: string;
  hull: string;
  hullEdge: string;
  select: string;
  sans: string;
}

function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    ink: v('--ink'),
    inkSoft: v('--ink-soft'),
    file: v('--file'),
    fn: v('--fn'),
    crate: v('--crate'),
    link: v('--link'),
    linkHot: v('--link-hot'),
    linkDim: v('--link-dim'),
    hull: v('--hull'),
    hullEdge: v('--hull-edge'),
    select: v('--select'),
    sans: v('--sans'),
  };
}

const FN_RADIUS = 3;
const HULL_PAD = 14;
const DOUBLE_CLICK_MS = 350;
const DIMMED_ALPHA = 0.15;

export interface GraphView {
  expand(fileId: number): void;
  focus(key: NodeKey): void;
  select(fnId: number): void;
}

export function createGraphView(
  root: HTMLElement,
  graph: Graph,
  onOpenFn: (fnId: number) => void,
): GraphView {
  const expanded = new Set<number>();
  const objects = new Map<NodeKey, SimNode>();
  const spawnAt = new Map<NodeKey, Point>();
  let hulls = new Map<number, Point[]>();
  let neighbors = new Map<NodeKey, Set<NodeKey>>();
  let hovered: SimNode | null = null;
  let selected: number | null = null;
  let lastFnClick: { fnId: number; at: number } | null = null;
  let theme = readTheme();
  let fitted = false;

  const radius = (n: ViewNode): number => {
    switch (n.kind) {
      case 'fn':
        return FN_RADIUS;
      case 'file': {
        const [start, end] = graph.files[n.id]!.fns;
        return 4 + 2.2 * Math.sqrt(end - start);
      }
      case 'crate':
        return 6;
    }
  };

  const fg = new ForceGraph<SimNode, SimLink>(root)
    .nodeId('key')
    .nodeRelSize(1)
    .nodeVal((n) => n.r * n.r)
    .nodeLabel(tooltip)
    .nodeCanvasObject(paintNode)
    .nodePointerAreaPaint((n, color, ctx) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, n.r + 2, 0, 2 * Math.PI);
      ctx.fill();
    })
    .linkWidth((l) => 0.6 + Math.log2(l.count) * 0.9)
    .linkDirectionalArrowLength((l) => 3.5 + Math.log2(l.count))
    .linkDirectionalArrowRelPos(1)
    .linkColor(linkColor)
    .onRenderFramePre(paintHulls)
    .onNodeHover((n) => {
      hovered = n;
      root.style.cursor = n && n.kind !== 'crate' ? 'pointer' : '';
    })
    .onNodeClick(clickNode)
    .onBackgroundClick(clickEmpty)
    .onLinkClick((_, e) => clickEmpty(e))
    .cooldownTicks(300)
    .onEngineStop(() => {
      if (fitted) return;
      fitted = true;
      fg.zoomToFit(400, 80);
    });

  new ResizeObserver(() => fg.width(root.clientWidth).height(root.clientHeight)).observe(root);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    theme = readTheme();
    redraw();
  });
  // Canvas text measured before the web font loads would keep the fallback face.
  document.fonts.ready.then(() => {
    theme = readTheme();
    redraw();
  });

  refresh();
  // Lets the browser verification script find node screen positions.
  if (import.meta.env.DEV) Object.assign(window, { __arachneGraph: fg });

  function refresh() {
    const view = project(graph, expanded);
    const nodes = view.nodes.map((vn) => {
      let obj = objects.get(vn.key);
      if (!obj) {
        obj = { ...vn, r: radius(vn) };
        objects.set(vn.key, obj);
      }
      const spawn = spawnAt.get(vn.key);
      if (spawn) {
        obj.x = spawn[0];
        obj.y = spawn[1];
        obj.vx = 0;
        obj.vy = 0;
      }
      return obj;
    });
    spawnAt.clear();
    neighbors = new Map();
    const link = (a: NodeKey, b: NodeKey) => {
      let s = neighbors.get(a);
      if (!s) neighbors.set(a, (s = new Set()));
      s.add(b);
    };
    for (const l of view.links) {
      link(l.source, l.target);
      link(l.target, l.source);
    }
    fg.graphData({ nodes, links: view.links });
  }

  // force-graph pauses painting once the layout settles and exposes no repaint call;
  // setting any accessor to a new function schedules one frame.
  function redraw() {
    fg.linkColor((l: SimLink) => linkColor(l));
  }

  function expand(fileId: number) {
    if (expanded.has(fileId)) return;
    const file = objects.get(fileKey(fileId));
    const [cx, cy] = [file?.x ?? 0, file?.y ?? 0];
    const [start, end] = graph.files[fileId]!.fns;
    const n = end - start;
    for (let fn = start; fn < end; fn++) {
      // A small ring instead of a single point, so the charge force has a direction to push.
      const a = (2 * Math.PI * (fn - start)) / n;
      const d = n === 1 ? 0 : 6;
      spawnAt.set(fnKey(fn), [cx + d * Math.cos(a), cy + d * Math.sin(a)]);
    }
    expanded.add(fileId);
    refresh();
  }

  function collapse(fileId: number) {
    if (!expanded.delete(fileId)) return;
    const [start, end] = graph.files[fileId]!.fns;
    let sx = 0;
    let sy = 0;
    for (let fn = start; fn < end; fn++) {
      const o = objects.get(fnKey(fn));
      sx += o?.x ?? 0;
      sy += o?.y ?? 0;
    }
    spawnAt.set(fileKey(fileId), [sx / (end - start), sy / (end - start)]);
    if (hovered?.kind === 'fn' && graph.fns[hovered.id]!.file === fileId) hovered = null;
    refresh();
  }

  function clickNode(n: SimNode) {
    switch (n.kind) {
      case 'file':
        expand(n.id);
        return;
      case 'crate':
        return;
      case 'fn': {
        const now = performance.now();
        if (lastFnClick?.fnId === n.id && now - lastFnClick.at < DOUBLE_CLICK_MS) {
          lastFnClick = null;
          collapse(graph.fns[n.id]!.file);
          return;
        }
        lastFnClick = { fnId: n.id, at: now };
        select(n.id);
        onOpenFn(n.id);
      }
    }
  }

  function clickEmpty(e: MouseEvent) {
    const rect = root.getBoundingClientRect();
    const p = fg.screen2GraphCoords(e.clientX - rect.left, e.clientY - rect.top);
    for (const [fileId, hull] of hulls) {
      if (insidePolygon(hull, [p.x, p.y])) {
        collapse(fileId);
        return;
      }
    }
  }

  function select(fnId: number) {
    selected = fnId;
    redraw();
  }

  function isDimmed(key: NodeKey): boolean {
    return hovered !== null && hovered.key !== key && !neighbors.get(hovered.key)?.has(key);
  }

  function linkColor(l: SimLink): string {
    if (!hovered) return theme.link;
    const s = typeof l.source === 'string' ? l.source : l.source.key;
    const t = typeof l.target === 'string' ? l.target : l.target.key;
    return s === hovered.key || t === hovered.key ? theme.linkHot : theme.linkDim;
  }

  function paintNode(n: SimNode, ctx: CanvasRenderingContext2D, scale: number) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    ctx.globalAlpha = isDimmed(n.key) ? DIMMED_ALPHA : 1;
    ctx.beginPath();
    ctx.arc(x, y, n.r, 0, 2 * Math.PI);
    ctx.fillStyle = n.kind === 'file' ? theme.file : n.kind === 'fn' ? theme.fn : theme.crate;
    ctx.fill();
    if (n.kind === 'fn' && n.id === selected) {
      ctx.lineWidth = 1.6 / Math.min(scale, 2);
      ctx.strokeStyle = theme.select;
      ctx.beginPath();
      ctx.arc(x, y, n.r + 2.2, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // Fn labels only once zoomed in, which keeps 5k-node frames cheap and legible.
    const showLabel = n.kind !== 'fn' || scale > 1.4 || n === hovered || n.id === selected;
    if (showLabel) {
      const size = (n.kind === 'fn' ? 11 : 12) / scale;
      ctx.font = `${n.kind === 'file' ? 600 : 400} ${size}px ${theme.sans}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = n.kind === 'crate' ? theme.inkSoft : theme.ink;
      ctx.fillText(nodeLabel(n), x, y + n.r + 2 / scale);
    }
    ctx.globalAlpha = 1;
  }

  function paintHulls(ctx: CanvasRenderingContext2D, scale: number) {
    hulls = new Map();
    for (const fileId of expanded) {
      const [start, end] = graph.files[fileId]!.fns;
      const pts: Point[] = [];
      for (let fn = start; fn < end; fn++) {
        const o = objects.get(fnKey(fn));
        if (o?.x !== undefined && o.y !== undefined) pts.push([o.x, o.y]);
      }
      if (!pts.length) continue;
      const hull = padded(pts, HULL_PAD);
      hulls.set(fileId, hull);
      ctx.beginPath();
      ctx.moveTo(hull[0]![0], hull[0]![1]);
      for (const [x, y] of hull.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = theme.hull;
      ctx.fill();
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = theme.hullEdge;
      ctx.stroke();

      let top = hull[0]!;
      for (const p of hull) if (p[1] < top[1]) top = p;
      ctx.font = `600 ${12 / scale}px ${theme.sans}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = theme.file;
      ctx.fillText(graph.files[fileId]!.label, top[0], top[1] - 3 / scale);
    }
  }

  function nodeLabel(n: SimNode): string {
    switch (n.kind) {
      case 'file':
        return graph.files[n.id]!.label;
      case 'fn':
        return graph.fns[n.id]!.label;
      case 'crate':
        return graph.crates[n.id]!.name;
    }
  }

  function tooltip(n: SimNode): string {
    switch (n.kind) {
      case 'file': {
        const f = graph.files[n.id]!;
        return `${escapeHtml(f.label)}<div class="tip-path">${escapeHtml(f.path)}</div>`;
      }
      case 'fn': {
        const f = graph.fns[n.id]!;
        return `${escapeHtml(f.label)}<div class="tip-path">${f.kind.replace('_', ' ')}, lines ${f.lines[0]}-${f.lines[1]}</div>`;
      }
      case 'crate':
        return `${escapeHtml(graph.crates[n.id]!.name)}<div class="tip-path">external crate</div>`;
    }
  }

  return {
    expand,
    select,
    focus(key) {
      const o = objects.get(key);
      if (o?.x === undefined || o.y === undefined) return;
      fg.centerAt(o.x, o.y, 600);
      fg.zoom(Math.max(fg.zoom(), 2.5), 600);
    },
  };
}

function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Minkowski sum of the points with a circle: one convex polygon that is both drawn and hit-tested.
function padded(points: Point[], pad: number): Point[] {
  const ring: Point[] = [];
  for (const [x, y] of convexHull(points)) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      ring.push([x + pad * Math.cos(a), y + pad * Math.sin(a)]);
    }
  }
  return convexHull(ring);
}

function insidePolygon(poly: Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

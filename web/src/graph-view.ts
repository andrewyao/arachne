import { forceCollide } from 'd3-force-3d';
import ForceGraph from 'force-graph';
import { LabelGrid, type Box } from './labels';
import { clusterForce } from './layout';
import {
  effectiveExpanded,
  fileKey,
  fnKey,
  openFiles,
  project,
  type ExpandMode,
  type NodeKey,
  type ViewNode,
} from './project';
import type { Graph } from './types';
import {
  hiddenKeyIndex,
  removeUserHidden,
  visible,
  type HiddenKey,
  type HiddenTarget,
  type Visible,
} from './visibility';

type SimNode = ViewNode & { x?: number; y?: number; vx?: number; vy?: number; r: number };
type SimLink = { source: NodeKey | SimNode; target: NodeKey | SimNode; count: number; via: boolean };
type Point = readonly [x: number, y: number];

interface Theme {
  ink: string;
  surface: string;
  file: string;
  fn: string;
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
    surface: v('--surface'),
    file: v('--file'),
    fn: v('--fn'),
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
const CHARGE_RANGE = 300;
const DIMMED_ALPHA = 0.15;
const VACANT_ALPHA = 0.35;
// Screen px: dash and gap of a link that runs through contracted private fns.
const VIA_DASH = [4, 3] as const;
const CHIP = { px: 11, padX: 6, gap: 6, height: 16 };
const COLLIDE_PAD = 2;
const CLUSTER = { pull: 0.15, gap: 16, push: 0.6, spacing: 20 };
const LINK_SAME_FILE = { distance: 18, strength: 1 };
const LINK_CROSS = { distance: 70, strength: 0.15 };
const LINK_MAX_WIDTH = 2.5;
// Below these zoom levels fn labels and arrowheads are noise rather than information.
const FN_LABEL_ZOOM = 1.2;
const ARROW_ZOOM = 3;
const LABEL_LINE = 1.25;
// Expanding zooms in until a fn is about 9 CSS px across, which is comfortably clickable.
const FOCUS_ZOOM = 9 / (2 * FN_RADIUS);
const FOCUS_MS = 600;
// Screen px. A click this close to a node's edge hits it; a click a little farther out is a
// near miss and does nothing, rather than falling through to the hull and collapsing the file.
const HIT_SLOP = 4;
const NEAR_MISS = 10;
const LINK_SLOP = 3;

interface Label {
  text: string;
  x: number;
  y: number;
  px: number;
  weight: 400 | 600;
  color: string;
  above: boolean;
  dimmed: boolean;
}

export interface GraphView {
  expand(fileId: number): void;
  focus(key: NodeKey): void;
  select(fnId: number): void;
  setMode(mode: ExpandMode): void;
  setHidden(keys: Iterable<HiddenKey>): void;
  setPrivateShown(fileId: number, shown: boolean): void;
  isPrivateShown(fileId: number): boolean;
  /** Private fns in the file that are contracted away unless the file shows its private fns. */
  privateCount(fileId: number): number;
  isUserHidden(target: HiddenTarget): boolean;
  isContracted(fnId: number): boolean;
}

export interface GraphViewEvents {
  onOpenFn(fnId: number): void;
  onContextMenu(target: HiddenTarget, e: MouseEvent): void;
}

export function createGraphView(root: HTMLElement, graph: Graph, events: GraphViewEvents): GraphView {
  const manual = new Set<number>();
  let mode: ExpandMode = 'manual';
  const keyIndex = hiddenKeyIndex(graph);
  let pruned = removeUserHidden(graph, [], keyIndex);
  const showPrivate = new Set<number>();
  let vis: Visible = visible(graph, pruned, showPrivate);
  // The files drawn as fns. A snapshot, so sync() can diff the old view against the new one.
  let expanded: ReadonlySet<number> = new Set();
  let drawn = new Set<NodeKey>();
  let chips: { fileId: number; box: Box }[] = [];
  const objects = new Map<NodeKey, SimNode>();
  const spawnAt = new Map<NodeKey, Point>();
  let hulls = new Map<number, Point[]>();
  let hullTops = new Map<number, Point>();
  // Files by size, then fns by degree: the order labels claim space when nothing is hovered.
  let labelOrder: SimNode[] = [];
  let placedLabels: Box[] = [];
  const textWidths = new Map<string, number>();
  let neighbors = new Map<NodeKey, Set<NodeKey>>();
  let hovered: SimNode | null = null;
  let selected: number | null = null;
  let lastFnClick: { fnId: number; at: number } | null = null;
  let theme = readTheme();
  let fitOnStop = true;
  let zoomK = 1;
  let origin = { x: 0, y: 0 };

  const radius = (n: ViewNode): number => {
    switch (n.kind) {
      case 'fn':
        return FN_RADIUS;
      case 'file': {
        const [start, end] = graph.files[n.id]!.fns;
        return 3 + 0.9 * Math.sqrt(end - start);
      }
    }
  };

  const measure = document.createElement('canvas').getContext('2d')!;

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
    .linkWidth(linkWidth)
    .linkLineDash((l) => (l.via ? VIA_DASH.map((d) => d / zoomK) : null))
    .linkDirectionalArrowLength((l) => (zoomK < ARROW_ZOOM ? 0 : 3 + Math.log2(l.count)))
    .linkDirectionalArrowRelPos(1)
    .linkColor(linkColor)
    .onRenderFramePre(beforeFrame)
    .onRenderFramePost(paintLabels)
    .onNodeHover((n) => {
      hovered = n;
      root.style.cursor = n || overChip ? 'pointer' : '';
    })
    // force-graph resolves clicks from a shadow canvas it repaints at most every 800 ms, so
    // while nodes or the camera move it reports whatever used to be under the pointer.
    // Every click is re-resolved against live positions instead, and links never take hits.
    .linkPointerAreaPaint(() => {})
    .onNodeClick((_, e) => click(e))
    .onBackgroundClick(click)
    .cooldownTicks(300)
    .onEngineStop(() => {
      if (!fitOnStop) return;
      fitOnStop = false;
      fg.zoomToFit(400, 80);
    });

  // Unbounded many-body repulsion dominated frame time with 5k expanded fns; distant
  // clusters barely push each other anyway.
  fg.d3Force('charge')?.distanceMax(CHARGE_RANGE);
  fg.d3Force('collide', forceCollide<SimNode>((n) => n.r + COLLIDE_PAD).iterations(2));
  fg.d3Force('cluster', clusterForce<SimNode>(fileOfFn, CLUSTER));
  const inFile = (l: SimLink) => {
    const a = fileOfFn(l.source as SimNode);
    return a !== undefined && a === fileOfFn(l.target as SimNode);
  };
  // d3's default link strength, 1 / min(degree), keeps hubs from being yanked around.
  const baseStrength = (l: SimLink) =>
    1 / Math.max(1, Math.min(degree(l.source as SimNode), degree(l.target as SimNode)));
  fg.d3Force('link')
    ?.distance((l: SimLink) => (inFile(l) ? LINK_SAME_FILE : LINK_CROSS).distance)
    .strength((l: SimLink) => (inFile(l) ? LINK_SAME_FILE : LINK_CROSS).strength * baseStrength(l));

  let overChip = false;
  root.addEventListener('mousemove', (e) => {
    const [sx, sy] = screenPoint(e);
    overChip = chipAt(sx, sy) !== undefined;
    root.style.cursor = hovered || overChip ? 'pointer' : '';
  });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = targetAt(e);
    if (target) events.onContextMenu(target, e);
  });

  new ResizeObserver(() => fg.width(root.clientWidth).height(root.clientHeight)).observe(root);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    theme = readTheme();
    redraw();
  });
  // Canvas text measured before the web font loads would keep the fallback face.
  document.fonts.ready.then(() => {
    theme = readTheme();
    textWidths.clear();
    redraw();
  });

  refresh();
  // Lets the browser verification script find node screen positions.
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __arachneGraph: fg,
      __arachneLabels: () => placedLabels,
      __arachneChips: () => chips,
      __arachneShowPrivate: setPrivateShown,
    });
  }

  function fileOfFn(n: SimNode): number | undefined {
    return n.kind === 'fn' ? graph.fns[n.id]!.file : undefined;
  }

  function degree(n: SimNode): number {
    return neighbors.get(n.key)?.size ?? 0;
  }

  function refresh() {
    const view = project(graph, vis, expanded);
    drawn = new Set(view.nodes.map((n) => n.key));
    if (hovered && !drawn.has(hovered.key)) hovered = null;
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
    const size = (n: SimNode) => (n.kind === 'file' ? n.r : 0);
    labelOrder = [...nodes].sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'file' ? -1 : 1) : size(b) - size(a) || degree(b) - degree(a),
    );
    fg.graphData({ nodes, links: view.links });
  }

  // force-graph pauses painting once the layout settles and exposes no repaint call;
  // setting any accessor to a new function schedules one frame.
  function redraw() {
    fg.linkColor((l: SimLink) => linkColor(l));
  }

  function expand(fileId: number) {
    if (mode === 'all' || manual.has(fileId)) return;
    manual.add(fileId);
    sync();
  }

  function collapse(fileId: number) {
    if (mode === 'all' || !manual.delete(fileId)) return;
    sync();
  }

  function setMode(next: ExpandMode) {
    if (next === mode) return;
    mode = next;
    sync();
    if (mode === 'all') {
      fitOnStop = true;
      fg.zoomToFit(FOCUS_MS, 80);
    }
  }

  function setHidden(keys: Iterable<HiddenKey>) {
    pruned = removeUserHidden(graph, keys, keyIndex);
    vis = visible(graph, pruned, showPrivate);
    sync();
  }

  function setPrivateShown(fileId: number, shown: boolean) {
    if (shown === showPrivate.has(fileId)) return;
    if (shown) showPrivate.add(fileId);
    else showPrivate.delete(fileId);
    vis = visible(graph, pruned, showPrivate);
    sync();
  }

  // Newly expanded files burst out from where their node was, fns newly shown in an open file
  // from the centroid of its fns, and newly collapsed files reappear at that centroid.
  function sync() {
    const next = openFiles(vis, effectiveExpanded(mode, manual, graph.files.length));
    for (const fileId of next) {
      if (!expanded.has(fileId)) spawnFns(fileId, fileCenter(fileId));
      else spawnFns(fileId, fnCentroid(fileId), (fn) => !drawn.has(fnKey(fn)));
    }
    for (const fileId of expanded) if (!next.has(fileId)) spawnAt.set(fileKey(fileId), fnCentroid(fileId));
    expanded = next;
    refresh();
  }

  function spawnFns(fileId: number, [cx, cy]: Point, only = (_fn: number) => true) {
    const [start, end] = graph.files[fileId]!.fns;
    const fns: number[] = [];
    for (let fn = start; fn < end; fn++) if (!vis.hiddenFns.has(fn) && only(fn)) fns.push(fn);
    fns.forEach((fn, i) => {
      // A small ring instead of a single point, so the charge force has a direction to push.
      const a = (2 * Math.PI * i) / fns.length;
      const d = fns.length === 1 ? 0 : 6;
      spawnAt.set(fnKey(fn), [cx + d * Math.cos(a), cy + d * Math.sin(a)]);
    });
  }

  function fileCenter(fileId: number): Point {
    const o = objects.get(fileKey(fileId));
    return [o?.x ?? 0, o?.y ?? 0];
  }

  function screenPoint(e: MouseEvent): Point {
    const rect = root.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function click(e: MouseEvent) {
    const [sx, sy] = screenPoint(e);
    const chip = chipAt(sx, sy);
    if (chip !== undefined) return setPrivateShown(chip, !showPrivate.has(chip));
    const p = fg.screen2GraphCoords(sx, sy);
    const k = fg.zoom();
    const hit = nearestNode(p.x, p.y);
    if (hit && hit.gap * k <= HIT_SLOP) return clickNode(hit.node);
    if (hit && hit.gap * k <= NEAR_MISS) return;
    if (onLink(sx, sy)) return;
    const hull = hullAt(p.x, p.y);
    if (hull !== undefined) collapse(hull);
  }

  function targetAt(e: MouseEvent): HiddenTarget | undefined {
    const [sx, sy] = screenPoint(e);
    const chip = chipAt(sx, sy);
    if (chip !== undefined) return { kind: 'file', id: chip };
    const p = fg.screen2GraphCoords(sx, sy);
    const hit = nearestNode(p.x, p.y);
    if (hit && hit.gap * fg.zoom() <= HIT_SLOP) return { kind: hit.node.kind, id: hit.node.id };
    const hull = hullAt(p.x, p.y);
    return hull === undefined ? undefined : { kind: 'file', id: hull };
  }

  function hullAt(x: number, y: number): number | undefined {
    for (const [fileId, hull] of hulls) if (insidePolygon(hull, [x, y])) return fileId;
    return undefined;
  }

  function chipAt(sx: number, sy: number): number | undefined {
    return chips.find(({ box }) => sx >= box.x0 && sx <= box.x1 && sy >= box.y0 && sy <= box.y1)?.fileId;
  }

  function nearestNode(x: number, y: number): { node: SimNode; gap: number } | null {
    let best: { node: SimNode; gap: number } | null = null;
    for (const n of fg.graphData().nodes) {
      const gap = Math.hypot((n.x ?? 0) - x, (n.y ?? 0) - y) - n.r;
      if (!best || gap < best.gap) best = { node: n, gap };
    }
    return best;
  }

  function onLink(sx: number, sy: number): boolean {
    const k = fg.zoom();
    const o = fg.screen2GraphCoords(0, 0);
    const toScreen = (n: SimNode): Point => [((n.x ?? 0) - o.x) * k, ((n.y ?? 0) - o.y) * k];
    for (const l of fg.graphData().links) {
      const [ax, ay] = toScreen(l.source as SimNode);
      const [bx, by] = toScreen(l.target as SimNode);
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(sx - (ax + t * dx), sy - (ay + t * dy));
      if (d <= linkWidth(l) / 2 + LINK_SLOP) return true;
    }
    return false;
  }

  function clickNode(n: SimNode) {
    switch (n.kind) {
      case 'file':
        expand(n.id);
        focus(n.key);
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
        events.onOpenFn(n.id);
      }
    }
  }

  function focus(key: NodeKey) {
    const at = centerOf(key);
    if (!at) return;
    // A pending auto-fit would otherwise zoom back out after the user acted.
    fitOnStop = false;
    fg.centerAt(at[0], at[1], FOCUS_MS);
    fg.zoom(Math.max(fg.zoom(), FOCUS_ZOOM), FOCUS_MS);
  }

  function centerOf(key: NodeKey): Point | null {
    const o = objects.get(key);
    if (o?.kind === 'file' && expanded.has(o.id)) return fnCentroid(o.id);
    return o?.x === undefined || o.y === undefined ? null : [o.x, o.y];
  }

  function fnCentroid(fileId: number): Point {
    const pts = drawnFnPoints(fileId);
    if (!pts.length) return fileCenter(fileId);
    let sx = 0;
    let sy = 0;
    for (const [x, y] of pts) {
      sx += x;
      sy += y;
    }
    return [sx / pts.length, sy / pts.length];
  }

  function drawnFnPoints(fileId: number): Point[] {
    const [start, end] = graph.files[fileId]!.fns;
    const pts: Point[] = [];
    for (let fn = start; fn < end; fn++) {
      const key = fnKey(fn);
      if (!drawn.has(key)) continue;
      const o = objects.get(key);
      if (o?.x !== undefined && o.y !== undefined) pts.push([o.x, o.y]);
    }
    return pts;
  }

  function select(fnId: number) {
    selected = fnId;
    redraw();
  }

  function isDimmed(key: NodeKey): boolean {
    return hovered !== null && hovered.key !== key && !neighbors.get(hovered.key)?.has(key);
  }

  function isVacant(n: SimNode): boolean {
    return n.kind === 'file' && vis.vacant.has(n.id);
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
    ctx.globalAlpha = isDimmed(n.key) ? DIMMED_ALPHA : isVacant(n) ? VACANT_ALPHA : 1;
    ctx.beginPath();
    ctx.arc(x, y, n.r, 0, 2 * Math.PI);
    ctx.fillStyle = n.kind === 'file' ? theme.file : theme.fn;
    ctx.fill();
    if (n.kind === 'fn' && n.id === selected) {
      ctx.lineWidth = 1.6 / Math.min(scale, 2);
      ctx.strokeStyle = theme.select;
      ctx.beginPath();
      ctx.arc(x, y, n.r + 2.2, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function beforeFrame(ctx: CanvasRenderingContext2D, scale: number) {
    zoomK = scale;
    origin = fg.screen2GraphCoords(0, 0);
    hulls = new Map();
    hullTops = new Map();
    for (const fileId of expanded) {
      const pts = drawnFnPoints(fileId);
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
      hullTops.set(fileId, top);
    }
  }

  function paintLabels(ctx: CanvasRenderingContext2D, scale: number) {
    const grid = new LabelGrid(fg.width(), fg.height());
    const done = new Set<NodeKey>();
    const near = hovered ? neighbors.get(hovered.key) : undefined;
    const nodeLabelOf = (n: SimNode): Label => ({
      text: nodeLabel(n),
      x: n.x ?? 0,
      y: (n.y ?? 0) + n.r,
      px: n.kind === 'fn' ? 11 : 12,
      weight: n.kind === 'file' ? 600 : 400,
      color: theme.ink,
      above: false,
      dimmed: isDimmed(n.key) || isVacant(n),
    });
    const tryNode = (n: SimNode | undefined) => {
      if (!n || done.has(n.key) || n.x === undefined) return;
      done.add(n.key);
      place(nodeLabelOf(n));
    };
    const place = (l: Label) => {
      const w = textWidth(l.text, l.px, l.weight);
      const h = l.px * LABEL_LINE;
      const sx = (l.x - origin.x) * scale;
      const sy = (l.y - origin.y) * scale + (l.above ? -3 : 2);
      const box = { x0: sx - w / 2, x1: sx + w / 2, y0: l.above ? sy - h : sy, y1: l.above ? sy : sy + h };
      if (box.x1 < 0 || box.y1 < 0 || box.x0 > fg.width() || box.y0 > fg.height()) return;
      if (!grid.tryPlace(box)) return;
      ctx.globalAlpha = l.dimmed ? DIMMED_ALPHA : 1;
      ctx.font = `${l.weight} ${l.px / scale}px ${theme.sans}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = l.above ? 'bottom' : 'top';
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.x, l.y + (l.above ? -3 : 2) / scale);
    };

    if (selected !== null && drawn.has(fnKey(selected))) tryNode(objects.get(fnKey(selected)));
    if (hovered) {
      tryNode(hovered);
      for (const k of near ?? []) tryNode(objects.get(k));
    }
    chips = [];
    const bySize = [...hullTops].sort(([a], [b]) => fnCount(b) - fnCount(a));
    for (const [fileId, [x, y]] of bySize) placeHullLabel(fileId, x, y);
    for (const n of labelOrder) {
      if (n.kind === 'fn' && scale < FN_LABEL_ZOOM) break;
      tryNode(n);
    }
    ctx.globalAlpha = 1;
    placedLabels = grid.placed;

    function placeHullLabel(fileId: number, x: number, y: number) {
      const text = graph.files[fileId]!.label;
      const count = vis.privateCounts.get(fileId) ?? 0;
      if (!count) return place({ text, x, y, px: 12, weight: 600, color: theme.file, above: true, dimmed: false });
      const chipText = `${count} private · ${showPrivate.has(fileId) ? 'hide' : 'show'}`;
      const labelW = textWidth(text, 12, 600);
      const chipW = textWidth(chipText, CHIP.px, 400) + 2 * CHIP.padX;
      const w = labelW + CHIP.gap + chipW;
      const h = Math.max(12 * LABEL_LINE, CHIP.height);
      const sx = (x - origin.x) * scale;
      const sy = (y - origin.y) * scale - 3;
      const box = { x0: sx - w / 2, x1: sx + w / 2, y0: sy - h, y1: sy };
      if (box.x1 < 0 || box.y1 < 0 || box.x0 > fg.width() || box.y0 > fg.height()) return;
      if (!grid.tryPlace(box)) return;
      const mid = sy - h / 2;
      const chipBox = { x0: box.x1 - chipW, x1: box.x1, y0: mid - CHIP.height / 2, y1: mid + CHIP.height / 2 };
      chips.push({ fileId, box: chipBox });

      const gx = (px: number) => origin.x + px / scale;
      const gy = (py: number) => origin.y + py / scale;
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `600 ${12 / scale}px ${theme.sans}`;
      ctx.fillStyle = theme.file;
      ctx.fillText(text, gx(box.x0), gy(mid));

      ctx.beginPath();
      ctx.roundRect(gx(chipBox.x0), gy(chipBox.y0), chipW / scale, CHIP.height / scale, CHIP.height / 2 / scale);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = theme.fn;
      ctx.stroke();
      ctx.font = `400 ${CHIP.px / scale}px ${theme.sans}`;
      ctx.fillStyle = theme.ink;
      ctx.fillText(chipText, gx(chipBox.x0 + CHIP.padX), gy(mid));
    }
  }

  function fnCount(fileId: number): number {
    const [start, end] = graph.files[fileId]!.fns;
    return end - start;
  }

  function textWidth(text: string, px: number, weight: number): number {
    const key = `${weight} ${px} ${text}`;
    let w = textWidths.get(key);
    if (w === undefined) {
      measure.font = `${weight} ${px}px ${theme.sans}`;
      w = measure.measureText(text).width;
      textWidths.set(key, w);
    }
    return w;
  }

  function nodeLabel(n: SimNode): string {
    switch (n.kind) {
      case 'file':
        return graph.files[n.id]!.label;
      case 'fn':
        return graph.fns[n.id]!.label;
    }
  }

  function tooltip(n: SimNode): string {
    switch (n.kind) {
      case 'file': {
        const f = graph.files[n.id]!;
        const vacant = {
          hidden: '<div class="tip-path">All fns hidden by you.</div>',
          private: '<div class="tip-path">Every fn is hidden. Right-click to show its private fns.</div>',
          none: '',
        }[vis.vacant.get(n.id) ?? 'none'];
        return `${escapeHtml(f.label)}<div class="tip-path">${escapeHtml(f.path)}</div>${vacant}`;
      }
      case 'fn': {
        const f = graph.fns[n.id]!;
        const kind = `${f.private ? 'private ' : ''}${f.kind.replace('_', ' ')}`;
        return `${escapeHtml(f.label)}<div class="tip-path">${kind}, lines ${f.lines[0]}-${f.lines[1]}</div>`;
      }
    }
  }

  return {
    expand,
    select,
    focus,
    setMode,
    setHidden,
    setPrivateShown,
    isPrivateShown: (fileId) => showPrivate.has(fileId),
    privateCount: (fileId) => vis.privateCounts.get(fileId) ?? 0,
    isUserHidden: (t) => (t.kind === 'file' ? pruned.files : pruned.fns).has(t.id),
    isContracted: (fnId) => vis.contracted.has(fnId),
  };
}

function linkWidth(l: SimLink): number {
  return Math.min(LINK_MAX_WIDTH, 0.5 + Math.log2(l.count) * 0.6);
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
    for (let k = 0; k < 10; k++) {
      const a = (k * Math.PI) / 5;
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

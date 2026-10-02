import { Camera, wheelFactor } from './camera';
import { LabelGrid, type Box } from './labels';
import { edgeKey, layout, ROW, type Layout, type Point } from './layered';
import {
  effectiveExpanded,
  fileKey,
  fnKey,
  openFiles,
  project,
  type ExpandMode,
  type NodeKey,
  type View,
  type ViewLink,
  type ViewNode,
} from './project';
import type { Graph } from './types';
import {
  removeUserHidden,
  visible,
  type HiddenKey,
  type HiddenTarget,
  type Visible,
} from './visibility';

interface Theme {
  ink: string;
  surface: string;
  file: string;
  fn: string;
  link: string;
  linkHot: string;
  linkDim: string;
  boxOpen: string;
  boxEdge: string;
  box: string;
  range: string;
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
    boxOpen: v('--box-open'),
    boxEdge: v('--box-edge'),
    box: v('--box'),
    range: v('--range'),
    select: v('--select'),
    sans: v('--sans'),
  };
}

// Graph units, inside a file's box: calls within the file arc through the gutter on the left,
// then each row has its fn's dot and label.
const GUTTER = 36;
const DOT_R = 3;
const LABEL_PX = 11;
const LABEL_INSET = GUTTER + 8;
const RIGHT_PAD = 12;
const EMPTY_WIDTH = 80;
// Below this many screen px, row labels are unreadable and are left out.
const MIN_LABEL_PX = 5;
const DOUBLE_CLICK_MS = 350;
const DIMMED_ALPHA = 0.15;
const VACANT_ALPHA = 0.35;
// Screen px: dash and gap of a call that runs through contracted private fns, and of one drawn
// against the flow because it closes a cycle.
const VIA_DASH = [4, 3];
const BACKWARD_DASH = [1, 3];
const CHIP = { px: 11, padX: 6, gap: 6, height: 16 };
const LINK_MAX_WIDTH = 2.5;
// Screen px. An arrowhead is `aspect` times as long as it is wide.
const ARROW = { length: 6, aspect: 1.6 };
const CURVE_STEPS = 24;
const LABEL_LINE = 1.25;
// Focusing a fn zooms in until its label reads at full size.
const FOCUS_ZOOM = 1.2;
// Focusing a file frames its box, but never zooms in past this.
const FOCUS_BOX_ZOOM = 2;
const FOCUS_MS = 600;
const RELAYOUT_MS = 450;
const FIT_PAD = 80;
// Screen px. A click this close to an open box's outline closes the file instead of hitting a row.
const EDGE_PX = 6;
const LINK_SLOP = 3;

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
  /** A contracted private fn, or a file emptied by contraction. */
  isPrivateHidden(target: HiddenTarget): boolean;
}

export interface GraphViewEvents {
  onOpenFn(fnId: number): void;
  onContextMenu(target: HiddenTarget, e: MouseEvent): void;
}

// Files sit in columns so calls between them point right; each file lists its fns, callers above
// callees, so calls within it point down. Every visible fn keeps its row whether or not its file
// is open: an open file shows its rows, a collapsed one is a solid box, and calls into or out of
// it still meet its edge at the fn's row.
export function createGraphView(
  root: HTMLElement,
  graph: Graph,
  hidden: { index: ReadonlyMap<HiddenKey, HiddenTarget>; keys: Iterable<HiddenKey> },
  events: GraphViewEvents,
): GraphView {
  const manual = new Set<number>();
  let mode: ExpandMode = 'manual';
  let pruned = removeUserHidden(graph, hidden.keys, hidden.index);
  const showPrivate = new Set<number>();
  let vis: Visible = visible(graph, pruned, showPrivate);
  let expanded: ReadonlySet<number> = new Set();
  let view: View = { nodes: [], links: [] };
  let theme = readTheme();
  const measure = document.createElement('canvas').getContext('2d')!;
  const textWidths = new Map<string, number>();
  let laid: Layout = relayout();
  // While a relayout animates, positions blend from `from` toward `laid`.
  let from: Layout | null = null;
  let relayoutAt = 0;
  let chips: { fileId: number; box: Box }[] = [];
  let placedLabels: Box[] = [];
  let neighbors = new Map<NodeKey, Set<NodeKey>>();
  let hovered: ViewNode | null = null;
  let selected: number | null = null;
  let lastFnClick: { fnId: number; at: number } | null = null;

  const canvas = document.createElement('canvas');
  const tip = document.createElement('div');
  tip.className = 'graph-tip';
  tip.hidden = true;
  root.append(canvas, tip);
  const ctx = canvas.getContext('2d')!;
  const camera = new Camera();

  let frameRequested = false;
  let pointer: Point | null = null;
  const pointers = new Map<number, Point>();
  let press: { moved: boolean } | null = null;
  let overChip = false;

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.ctrlKey) return;
    root.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, screenPoint(e));
    if (pointers.size > 1 && press) press.moved = true;
    else press = { moved: false };
  });
  root.addEventListener('pointermove', (e) => {
    const p = screenPoint(e);
    pointer = p;
    const prev = pointers.get(e.pointerId);
    if (prev && press) {
      pointers.set(e.pointerId, p);
      // Any mouse movement while pressed makes the release a pan rather than a click.
      if (e.pointerType === 'mouse' || Math.abs(e.movementX) > 1 || Math.abs(e.movementY) > 1) press.moved = true;
      if (pointers.size === 2) pinch(e.pointerId, prev);
      else camera.panBy(p[0] - prev[0], p[1] - prev[1]);
    }
    overChip = chipAt(p) !== undefined;
    invalidate();
  });
  for (const type of ['pointerup', 'pointercancel'] as const) {
    root.addEventListener(type, (e) => {
      if (!pointers.delete(e.pointerId) || pointers.size) return;
      const done = press;
      press = null;
      if (done && !done.moved && type === 'pointerup') click(e);
      invalidate();
    });
  }
  root.addEventListener('pointerleave', () => {
    pointer = null;
    invalidate();
  });
  root.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [sx, sy] = screenPoint(e);
      camera.zoomAt(sx, sy, camera.k * wheelFactor(e));
      invalidate();
    },
    { passive: false },
  );
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = targetAt(screenPoint(e));
    if (target) events.onContextMenu(target, e);
  });

  let fitted = false;
  const resize = () => {
    camera.width = root.clientWidth;
    camera.height = root.clientHeight;
    const dpr = window.devicePixelRatio;
    canvas.width = Math.max(1, Math.round(camera.width * dpr));
    canvas.height = Math.max(1, Math.round(camera.height * dpr));
    canvas.style.width = `${camera.width}px`;
    canvas.style.height = `${camera.height}px`;
    if (!fitted && camera.width && camera.height) {
      fitted = true;
      fitAll();
    }
    invalidate();
  };
  resize();
  new ResizeObserver(resize).observe(root);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    theme = readTheme();
    invalidate();
  });
  // Box widths come from label widths, which change once the web font replaces the fallback.
  document.fonts.ready.then(() => {
    theme = readTheme();
    textWidths.clear();
    laid = relayout();
    invalidate();
  });

  refresh();
  // Lets the browser verification script find rows and boxes on screen.
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __arachneView: {
        nodes: () =>
          view.nodes.map((n) => {
            const [x, y] = nodePoint(n);
            return { key: n.key, kind: n.kind, x, y };
          }),
        links: () => view.links,
        layout: () => laid,
        camera: () => ({ k: camera.k, x: camera.x, y: camera.y }),
      },
      __arachneLabels: () => placedLabels,
      __arachneChips: () => chips,
      __arachneShowPrivate: setPrivateShown,
    });
  }

  function invalidate() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(frame);
  }

  function frame(now: number) {
    frameRequested = false;
    const moving = camera.step(now);
    if (from && now - relayoutAt >= RELAYOUT_MS) from = null;
    const next = press?.moved || !pointer ? null : hoverAt(pointer);
    if (next?.key !== hovered?.key) {
      hovered = next;
      tip.innerHTML = hovered ? tooltip(hovered) : '';
    }
    placeTip();
    root.style.cursor = hovered || overChip ? 'pointer' : '';
    paint(now);
    if (moving || from) invalidate();
  }

  /** The layout of every visible fn, open file or not. */
  function relayout(): Layout {
    const files = new Map<number, number[]>();
    graph.files.forEach((file, id) => {
      const [start, end] = file.fns;
      if (start === end || vis.hiddenFiles.has(id)) return;
      const fns: number[] = [];
      for (let fn = start; fn < end; fn++) if (!vis.hiddenFns.has(fn)) fns.push(fn);
      files.set(id, fns);
    });
    const width = (file: number) => {
      const fns = files.get(file)!;
      if (!fns.length) return EMPTY_WIDTH;
      return LABEL_INSET + Math.max(...fns.map((fn) => textWidth(rowLabel(fn), LABEL_PX, 400))) + RIGHT_PAD;
    };
    return layout({ files, edges: vis.edges.map(([a, b]) => [a, b] as const), width });
  }

  // Visibility changed, so fns may have come or gone: lay out again and glide there.
  function revise() {
    const now = performance.now();
    from = snapshot(now);
    relayoutAt = now;
    laid = relayout();
    sync();
  }

  /** Where everything is drawn at `now`, partway through a relayout included. */
  function snapshot(now = performance.now()): Layout {
    if (!from) return laid;
    const t = ease(Math.min(1, (now - relayoutAt) / RELAYOUT_MS));
    const fns = new Map<number, Point>();
    for (const [fn, b] of laid.fns) {
      const a = from.fns.get(fn);
      fns.set(fn, a ? [lerp(a[0], b[0], t), lerp(a[1], b[1], t)] : b);
    }
    const boxes = new Map<number, Box>();
    for (const [file, b] of laid.boxes) {
      const a = from.boxes.get(file);
      boxes.set(file, a ? { x0: lerp(a.x0, b.x0, t), y0: lerp(a.y0, b.y0, t), x1: lerp(a.x1, b.x1, t), y1: lerp(a.y1, b.y1, t) } : b);
    }
    return { fns, boxes, backward: laid.backward };
  }

  function sync() {
    expanded = openFiles(vis, effectiveExpanded(mode, manual, graph.files.length));
    refresh();
  }

  function refresh() {
    view = project(graph, vis, expanded);
    if (hovered && !view.nodes.some((n) => n.key === hovered!.key)) hovered = null;
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
    invalidate();
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
  }

  function setHidden(keys: Iterable<HiddenKey>) {
    pruned = removeUserHidden(graph, keys, hidden.index);
    vis = visible(graph, pruned, showPrivate);
    revise();
  }

  function setPrivateShown(fileId: number, shown: boolean) {
    if (shown === showPrivate.has(fileId)) return;
    if (shown) showPrivate.add(fileId);
    else showPrivate.delete(fileId);
    vis = visible(graph, pruned, showPrivate);
    revise();
  }

  function fitAll() {
    const boxes = [...laid.boxes.values()];
    if (!boxes.length) return;
    camera.fit(
      {
        x0: Math.min(...boxes.map((b) => b.x0)),
        y0: Math.min(...boxes.map((b) => b.y0)),
        x1: Math.max(...boxes.map((b) => b.x1)),
        y1: Math.max(...boxes.map((b) => b.y1)),
      },
      FIT_PAD,
    );
  }

  function screenPoint(e: MouseEvent): Point {
    const rect = root.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function pinch(id: number, prev: Point) {
    const other = [...pointers].find(([pid]) => pid !== id)![1];
    const p = pointers.get(id)!;
    const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const [ox, oy] = mid(prev, other);
    const [nx, ny] = mid(p, other);
    const before = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
    const after = Math.hypot(p[0] - other[0], p[1] - other[1]);
    camera.panBy(nx - ox, ny - oy);
    if (before > 0) camera.zoomAt(nx, ny, (camera.k * after) / before);
  }

  /** What the point is over: a chip, a row of an open file, near an open box's outline, or a box. */
  function pick(p: Point): { chip: number } | { fn: number } | { edge: number } | { box: number } | null {
    const chip = chipAt(p);
    if (chip !== undefined) return { chip };
    const [x, y] = camera.toGraph(...p);
    const at = snapshot();
    for (const [file, b] of at.boxes) {
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (!expanded.has(file)) return { box: file };
      const edge = Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y) * camera.k;
      if (edge <= EDGE_PX) return { edge: file };
      const fn = rowAt(file, y, at);
      return fn === undefined ? { edge: file } : { fn };
    }
    return null;
  }

  function rowAt(file: number, y: number, at: Layout): number | undefined {
    const [start, end] = graph.files[file]!.fns;
    for (let fn = start; fn < end; fn++) {
      const row = at.fns.get(fn);
      if (row && Math.abs(row[1] - y) <= ROW / 2) return fn;
    }
    return undefined;
  }

  function click(e: MouseEvent) {
    const p = screenPoint(e);
    const hit = pick(p);
    if (!hit) return;
    if ('chip' in hit) return setPrivateShown(hit.chip, !showPrivate.has(hit.chip));
    if ('fn' in hit) return clickFn(hit.fn);
    // Calls cross boxes everywhere. Near an open box's outline, a click on one is a near miss
    // rather than a request to close the file.
    if ('edge' in hit) return onLink(p) ? undefined : collapse(hit.edge);
    expand(hit.box);
    focus(fileKey(hit.box));
  }

  function targetAt(p: Point): HiddenTarget | undefined {
    const hit = pick(p);
    if (!hit) return undefined;
    if ('fn' in hit) return { kind: 'fn', id: hit.fn };
    return { kind: 'file', id: 'chip' in hit ? hit.chip : 'edge' in hit ? hit.edge : hit.box };
  }

  /** The row under the point, else the collapsed file whose box holds it. */
  function hoverAt(p: Point): ViewNode | null {
    const hit = pick(p);
    if (hit && 'fn' in hit) return { kind: 'fn', key: fnKey(hit.fn), id: hit.fn };
    if (hit && 'box' in hit) return { kind: 'file', key: fileKey(hit.box), id: hit.box };
    return null;
  }

  function chipAt([sx, sy]: Point): number | undefined {
    return chips.find(({ box }) => sx >= box.x0 && sx <= box.x1 && sy >= box.y0 && sy <= box.y1)?.fileId;
  }

  function onLink([sx, sy]: Point): boolean {
    const at = snapshot();
    for (const l of view.links) {
      const pts = curve(l, at).map(([x, y]) => camera.toScreen(x, y));
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1]!;
        const [bx, by] = pts[i]!;
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(sx - (ax + t * dx), sy - (ay + t * dy)) <= linkWidth(l) / 2 + LINK_SLOP) return true;
      }
    }
    return false;
  }

  function clickFn(fnId: number) {
    const now = performance.now();
    if (lastFnClick?.fnId === fnId && now - lastFnClick.at < DOUBLE_CLICK_MS) {
      lastFnClick = null;
      collapse(graph.fns[fnId]!.file);
      return;
    }
    lastFnClick = { fnId, at: now };
    select(fnId);
    events.onOpenFn(fnId);
  }

  function focus(key: NodeKey) {
    const at = snapshot();
    const id = Number(key.slice(key.indexOf(':') + 1));
    if (key.startsWith('fn:')) {
      const row = at.fns.get(id);
      if (!row) return;
      const b = at.boxes.get(graph.fns[id]!.file)!;
      camera.centerAt((b.x0 + b.x1) / 2, row[1], FOCUS_MS);
      camera.zoomTo(Math.max(camera.k, FOCUS_ZOOM), FOCUS_MS);
    } else {
      const b = at.boxes.get(id);
      if (!b) return;
      camera.centerAt((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, FOCUS_MS);
      const fit = Math.min((camera.width - 2 * FIT_PAD) / (b.x1 - b.x0), (camera.height - 2 * FIT_PAD) / (b.y1 - b.y0));
      camera.zoomTo(Math.min(FOCUS_BOX_ZOOM, fit), FOCUS_MS);
    }
    invalidate();
  }

  function select(fnId: number) {
    selected = fnId;
    invalidate();
  }

  function nodePoint(n: ViewNode): Point {
    const at = snapshot();
    if (n.kind === 'fn') return dot(n.id, at);
    const b = at.boxes.get(n.id)!;
    return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  }

  function dot(fn: number, at: Layout): Point {
    const [x, y] = at.fns.get(fn)!;
    return [x + GUTTER, y];
  }

  /** A fn's label within its file's box, without the file's own name in front. */
  function rowLabel(fn: number): string {
    const label = graph.fns[fn]!.label;
    const prefix = `${graph.files[graph.fns[fn]!.file]!.label}.`;
    return label.startsWith(prefix) ? label.slice(prefix.length) : label;
  }

  function isDimmed(key: NodeKey): boolean {
    return hovered !== null && hovered.key !== key && !neighbors.get(hovered.key)?.has(key);
  }

  function linkColor(l: ViewLink): string {
    if (!hovered) return theme.link;
    return l.source === hovered.key || l.target === hovered.key ? theme.linkHot : theme.linkDim;
  }

  /**
   * A call within a file arcs through the gutter from its caller's dot to its callee's. A call
   * between files leaves the caller's box at the caller's row, heading right, and enters the
   * callee's box at the callee's row, heading right.
   */
  function curve(l: ViewLink, at: Layout): Point[] {
    const [caller, callee] = l.sample;
    const fa = graph.fns[caller]!.file;
    const fb = graph.fns[callee]!.file;
    let a: Point, c1: Point, c2: Point, b: Point;
    if (fa === fb) {
      a = dot(caller, at);
      b = dot(callee, at);
      const bulge = Math.min(GUTTER - 6, 8 + 4 * Math.sqrt(Math.abs(b[1] - a[1]) / ROW));
      c1 = [a[0] - bulge, a[1]];
      c2 = [b[0] - bulge, b[1]];
    } else {
      a = [at.boxes.get(fa)!.x1, at.fns.get(caller)![1]];
      b = [at.boxes.get(fb)!.x0, at.fns.get(callee)![1]];
      const reach = Math.max(Math.abs(b[0] - a[0]) / 2, 40);
      c1 = [a[0] + reach, a[1]];
      c2 = [b[0] - reach, b[1]];
    }
    const pts: Point[] = [];
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
      pts.push([
        w[0] * a[0] + w[1] * c1[0] + w[2] * c2[0] + w[3] * b[0],
        w[0] * a[1] + w[1] * c1[1] + w[2] * c2[1] + w[3] * b[1],
      ]);
    }
    return pts;
  }

  // Back to front: calls between files, opaque boxes over them, row highlights, calls within
  // files, arrowheads, rows, then file labels. A call between files passes under every box.
  function paint(now: number) {
    const at = snapshot(now);
    const dpr = canvas.width / Math.max(1, camera.width);
    const k = camera.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, camera.width, camera.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (camera.width / 2 - camera.x * k), dpr * (camera.height / 2 - camera.y * k));

    const heads: { tip: Point; from: Point; color: string; scale: number }[] = [];
    const stroke = (l: ViewLink) => {
      const pts = curve(l, at);
      ctx.beginPath();
      ctx.moveTo(...pts[0]!);
      for (const p of pts.slice(1)) ctx.lineTo(...p);
      ctx.strokeStyle = linkColor(l);
      ctx.lineWidth = linkWidth(l) / k;
      const dash = laid.backward.has(edgeKey(...l.sample)) ? BACKWARD_DASH : l.via ? VIA_DASH : [];
      ctx.setLineDash(dash.map((d) => d / k));
      ctx.stroke();
      heads.push({ tip: pts.at(-1)!, from: pts.at(-2)!, color: linkColor(l), scale: 1 + Math.log2(l.count) / 4 });
    };
    const within = (l: ViewLink) => graph.fns[l.sample[0]]!.file === graph.fns[l.sample[1]]!.file;
    for (const l of view.links) if (!within(l)) stroke(l);
    ctx.setLineDash([]);

    for (const [file, b] of at.boxes) {
      const open = expanded.has(file);
      ctx.beginPath();
      ctx.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 6);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      ctx.globalAlpha = open ? 1 : isDimmed(fileKey(file)) ? DIMMED_ALPHA : vis.vacant.has(file) ? VACANT_ALPHA : 1;
      ctx.fillStyle = open ? theme.boxOpen : theme.box;
      ctx.fill();
      ctx.lineWidth = 1 / k;
      ctx.strokeStyle = theme.boxEdge;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const fn of [selected, hovered?.kind === 'fn' ? hovered.id : null]) {
      if (fn === null || !view.nodes.some((n) => n.key === fnKey(fn))) continue;
      const b = at.boxes.get(graph.fns[fn]!.file)!;
      const [, y] = at.fns.get(fn)!;
      ctx.fillStyle = theme.range;
      ctx.fillRect(b.x0, y - ROW / 2, b.x1 - b.x0, ROW);
    }

    for (const l of view.links) if (within(l)) stroke(l);
    ctx.setLineDash([]);
    for (const { tip: [tx, ty], from: [fx, fy], color, scale } of heads) {
      const d = Math.hypot(tx - fx, ty - fy) || 1;
      const [ux, uy] = [(tx - fx) / d, (ty - fy) / d];
      const length = (ARROW.length * scale) / k;
      const half = length / ARROW.aspect / 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - ux * length - uy * half, ty - uy * length + ux * half);
      ctx.lineTo(tx - ux * length * 0.8, ty - uy * length * 0.8);
      ctx.lineTo(tx - ux * length + uy * half, ty - uy * length - ux * half);
      ctx.fillStyle = color;
      ctx.fill();
    }

    const labels = LABEL_PX * k >= MIN_LABEL_PX;
    ctx.font = `400 ${LABEL_PX}px ${theme.sans}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const n of view.nodes) {
      if (n.kind !== 'fn') continue;
      const [x, y] = dot(n.id, at);
      ctx.globalAlpha = isDimmed(n.key) ? DIMMED_ALPHA : 1;
      ctx.beginPath();
      ctx.arc(x, y, DOT_R, 0, 2 * Math.PI);
      ctx.fillStyle = theme.fn;
      ctx.fill();
      if (n.id === selected) {
        ctx.lineWidth = 1.6 / Math.min(k, 2);
        ctx.strokeStyle = theme.select;
        ctx.beginPath();
        ctx.arc(x, y, DOT_R + 2.2, 0, 2 * Math.PI);
        ctx.stroke();
      }
      if (labels) {
        ctx.fillStyle = theme.ink;
        ctx.fillText(rowLabel(n.id), x - GUTTER + LABEL_INSET, y);
      }
    }
    ctx.globalAlpha = 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintFileLabels(at);
  }

  // A file's label sits on its box's top-left corner, an open file's followed by its private-fn
  // chip. Open and bigger files claim space first, and a label that would overlap one already
  // placed is left out.
  function paintFileLabels(at: Layout) {
    const grid = new LabelGrid(camera.width, camera.height);
    chips = [];
    const files = [...at.boxes.keys()].sort(
      (a, b) => Number(expanded.has(b)) - Number(expanded.has(a)) || fnCount(b) - fnCount(a) || a - b,
    );
    if (hovered?.kind === 'file') files.unshift(hovered.id);
    const done = new Set<number>();
    for (const fileId of files) {
      if (done.has(fileId)) continue;
      done.add(fileId);
      const b = at.boxes.get(fileId)!;
      const text = graph.files[fileId]!.label;
      // Only an open file carries its chip; zoomed out, chips on collapsed boxes would bury them.
      const count = expanded.has(fileId) ? (vis.privateCounts.get(fileId) ?? 0) : 0;
      const chipText = `${count} private · ${showPrivate.has(fileId) ? 'hide' : 'show'}`;
      const labelW = textWidth(text, 12, 600);
      const chipW = count ? textWidth(chipText, CHIP.px, 400) + 2 * CHIP.padX : 0;
      const w = labelW + (count ? CHIP.gap + chipW : 0);
      const h = Math.max(12 * LABEL_LINE, count ? CHIP.height : 0);
      const [sx, top] = camera.toScreen(b.x0, b.y0);
      const sy = top - 3;
      const box = { x0: sx, x1: sx + w, y0: sy - h, y1: sy };
      if (box.x1 < 0 || box.y1 < 0 || box.x0 > camera.width || box.y0 > camera.height) continue;
      if (!grid.tryPlace(box)) continue;
      const mid = sy - h / 2;
      ctx.globalAlpha = isDimmed(fileKey(fileId)) && !expanded.has(fileId) ? DIMMED_ALPHA : 1;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `600 12px ${theme.sans}`;
      ctx.fillStyle = theme.file;
      ctx.fillText(text, box.x0, mid);
      if (!count) continue;
      const chipBox = { x0: box.x1 - chipW, x1: box.x1, y0: mid - CHIP.height / 2, y1: mid + CHIP.height / 2 };
      chips.push({ fileId, box: chipBox });
      ctx.beginPath();
      ctx.roundRect(chipBox.x0, chipBox.y0, chipW, CHIP.height, CHIP.height / 2);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.fn;
      ctx.stroke();
      ctx.font = `400 ${CHIP.px}px ${theme.sans}`;
      ctx.fillStyle = theme.ink;
      ctx.fillText(chipText, chipBox.x0 + CHIP.padX, mid);
    }
    ctx.globalAlpha = 1;
    placedLabels = grid.placed;
  }

  // Follows the pointer, shifted left in proportion to how far right it is so it never runs off
  // the stage, and flipped above the pointer near the bottom edge.
  function placeTip() {
    tip.hidden = !hovered || !pointer;
    if (!hovered || !pointer) return;
    const [x, y] = pointer;
    const { width, height } = camera;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    const dy = height > 130 && height - y < 100 ? 'calc(-100% - 6px)' : '21px';
    tip.style.transform = `translate(-${(x / width) * 100}%, ${dy})`;
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

  function tooltip(n: ViewNode): string {
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
        const cycle = view.links.some(
          (l) => (l.source === n.key || l.target === n.key) && laid.backward.has(edgeKey(...l.sample)),
        );
        const note = cycle ? '<div class="tip-path">In a call cycle: a dotted call runs against the flow.</div>' : '';
        return `${escapeHtml(f.label)}<div class="tip-path">${kind}, lines ${f.lines[0]}-${f.lines[1]}</div>${note}`;
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
    isPrivateHidden: (t) => (t.kind === 'fn' ? vis.contracted.has(t.id) : vis.vacant.get(t.id) === 'private'),
  };
}

function linkWidth(l: ViewLink): number {
  return Math.min(LINK_MAX_WIDTH, 0.5 + Math.log2(l.count) * 0.6);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * (2 - t);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

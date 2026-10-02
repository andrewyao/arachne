import type { Point } from './layered';

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 1000;

interface Tween {
  from: number[];
  to: number[];
  start: number;
  ms: number;
  set(v: number[]): void;
}

// Maps graph coordinates to screen px. The graph point (x, y) sits at the viewport's center,
// so resizing the viewport keeps the same point centered.
export class Camera {
  k = 1;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  // Centering and zooming animate independently, so a focus can run both at once.
  private tweens = new Map<'center' | 'zoom', Tween>();

  toGraph(sx: number, sy: number): Point {
    return [this.x + (sx - this.width / 2) / this.k, this.y + (sy - this.height / 2) / this.k];
  }

  toScreen(x: number, y: number): Point {
    return [(x - this.x) * this.k + this.width / 2, (y - this.y) * this.k + this.height / 2];
  }

  /** Zooms to k while the graph point under (sx, sy) stays put. */
  zoomAt(sx: number, sy: number, k: number) {
    const [gx, gy] = this.toGraph(sx, sy);
    this.k = clampZoom(k);
    this.x = gx - (sx - this.width / 2) / this.k;
    this.y = gy - (sy - this.height / 2) / this.k;
  }

  panBy(dx: number, dy: number) {
    this.x -= dx / this.k;
    this.y -= dy / this.k;
  }

  centerAt(x: number, y: number, ms = 0) {
    this.animate('center', [this.x, this.y], [x, y], ms, ([cx, cy]) => {
      this.x = cx!;
      this.y = cy!;
    });
  }

  zoomTo(k: number, ms = 0) {
    this.animate('zoom', [this.k], [k], ms, ([z]) => (this.k = clampZoom(z!)));
  }

  /** Frames the box with `padding` screen px on every side. */
  fit(box: { x0: number; y0: number; x1: number; y1: number }, padding: number, ms = 0) {
    const k = Math.min((this.width - 2 * padding) / (box.x1 - box.x0), (this.height - 2 * padding) / (box.y1 - box.y0));
    this.centerAt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, ms);
    this.zoomTo(Math.max(1e-12, Math.min(1e12, k)), ms);
  }

  /** Advances the animations to `now`. True while any is still running. */
  step(now: number): boolean {
    for (const [name, t] of this.tweens) {
      const p = Math.min(1, Math.max(0, (now - t.start) / t.ms));
      const e = p * (2 - p);
      t.set(t.from.map((f, i) => f + (t.to[i]! - f) * e));
      if (p === 1) this.tweens.delete(name);
    }
    return this.tweens.size > 0;
  }

  private animate(name: 'center' | 'zoom', from: number[], to: number[], ms: number, set: (v: number[]) => void) {
    this.tweens.delete(name);
    if (ms <= 0) return set(to);
    this.tweens.set(name, { from, to, start: performance.now(), ms, set });
  }
}

/** The zoom factor one wheel event applies, matching d3-zoom's default. */
export function wheelFactor(e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
  return 2 ** (-e.deltaY * unit * (e.ctrlKey ? 10 : 1));
}

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

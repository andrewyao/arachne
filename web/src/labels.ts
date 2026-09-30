export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const CELL = 64;

// Screen-space occupancy for one frame. Labels are placed greedily, so a box is only ever
// tested against boxes already accepted, bucketed by the grid cells it touches.
export class LabelGrid {
  readonly placed: Box[] = [];
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: Box[][];

  constructor(width: number, height: number) {
    this.cols = Math.max(1, Math.ceil(width / CELL));
    this.rows = Math.max(1, Math.ceil(height / CELL));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  // Adds the box and returns true if it overlaps nothing placed so far.
  tryPlace(b: Box): boolean {
    const c0 = this.clamp(Math.floor(b.x0 / CELL), this.cols);
    const c1 = this.clamp(Math.floor(b.x1 / CELL), this.cols);
    const r0 = this.clamp(Math.floor(b.y0 / CELL), this.rows);
    const r1 = this.clamp(Math.floor(b.y1 / CELL), this.rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const o of this.cells[r * this.cols + c]!) {
          if (b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1) return false;
        }
      }
    }
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.cells[r * this.cols + c]!.push(b);
    this.placed.push(b);
    return true;
  }

  private clamp(i: number, n: number): number {
    return Math.min(n - 1, Math.max(0, i));
  }
}

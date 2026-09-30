import { describe, expect, it } from 'vitest';
import { LabelGrid } from './labels';

describe('LabelGrid', () => {
  it('rejects a box overlapping one already placed, including across grid cells', () => {
    const g = new LabelGrid(400, 200);
    expect(g.tryPlace({ x0: 50, y0: 50, x1: 250, y1: 62 })).toBe(true);
    expect(g.tryPlace({ x0: 200, y0: 60, x1: 300, y1: 72 })).toBe(false);
    expect(g.placed).toHaveLength(1);
  });

  it('accepts boxes that only touch edges', () => {
    const g = new LabelGrid(400, 200);
    expect(g.tryPlace({ x0: 0, y0: 0, x1: 100, y1: 10 })).toBe(true);
    expect(g.tryPlace({ x0: 100, y0: 0, x1: 200, y1: 10 })).toBe(true);
    expect(g.tryPlace({ x0: 0, y0: 10, x1: 100, y1: 20 })).toBe(true);
  });

  it('still detects overlap for boxes hanging off the canvas', () => {
    const g = new LabelGrid(100, 100);
    expect(g.tryPlace({ x0: -80, y0: 90, x1: 20, y1: 130 })).toBe(true);
    expect(g.tryPlace({ x0: -40, y0: 120, x1: -10, y1: 140 })).toBe(false);
  });
});

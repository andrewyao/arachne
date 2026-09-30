import { describe, expect, it } from 'vitest';
import { clusterForce, type Body } from './layout';

type Node = Body & { group: number };

// Integrates like d3-force: velocity decay 0.4, alpha decaying from 1 over ~300 ticks.
function run(nodes: Node[], ticks: number) {
  const force = clusterForce<Node>((n) => n.group, { pull: 0.15, gap: 16, push: 0.6, spacing: 20 });
  force.initialize(nodes);
  let alpha = 1;
  for (let t = 0; t < ticks; t++) {
    alpha += (0 - alpha) * 0.0228;
    force(alpha);
    for (const n of nodes) {
      n.vx! *= 0.6;
      n.vy! *= 0.6;
      n.x! += n.vx!;
      n.y! += n.vy!;
    }
  }
}

function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

describe('clusterForce', () => {
  it('stays bounded when every file is expanded at once into overlapping groups', () => {
    const rand = seeded(7);
    const nodes: Node[] = [];
    for (let group = 0; group < 72; group++) {
      const cx = (rand() - 0.5) * 60;
      const cy = (rand() - 0.5) * 60;
      const size = 2 + Math.floor(rand() * 60);
      for (let i = 0; i < size; i++) {
        nodes.push({ group, r: 3, x: cx + rand() * 6, y: cy + rand() * 6, vx: 0, vy: 0 });
      }
    }
    run(nodes, 300);
    const extent = Math.max(...nodes.map((n) => Math.max(Math.abs(n.x!), Math.abs(n.y!))));
    expect(Number.isFinite(extent)).toBe(true);
    expect(extent).toBeLessThan(5000);
  });

  it('pulls a group together and pushes an outsider clear of it', () => {
    const nodes: Node[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ group: 0, r: 3, x: (i % 5) * 30, y: Math.floor(i / 5) * 30, vx: 0, vy: 0 })),
      { group: 1, r: 3, x: 60, y: 45, vx: 0, vy: 0 },
    ];
    run(nodes, 300);
    const members = nodes.slice(0, 20);
    const cx = members.reduce((s, n) => s + n.x!, 0) / 20;
    const cy = members.reduce((s, n) => s + n.y!, 0) / 20;
    const reach = Math.max(...members.map((n) => Math.hypot(n.x! - cx, n.y! - cy)));
    const outsider = nodes[20]!;
    expect(reach).toBeLessThan(60);
    expect(Math.hypot(outsider.x! - cx, outsider.y! - cy)).toBeGreaterThan(reach + 3);
  });
});

export interface Body {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  r: number;
}

interface Group<N> {
  members: N[];
  cx: number;
  cy: number;
  reach: number;
}

// Pulls each group's members toward their centroid and pushes every non-member out of the
// group's disc, so an expanded file reads as one compact blob that never swallows other nodes.
export function clusterForce<N extends Body>(
  groupOf: (n: N) => number | undefined,
  { pull, gap, push }: { pull: number; gap: number; push: number },
) {
  let nodes: N[] = [];
  const force = (alpha: number) => {
    const groups = new Map<number, Group<N>>();
    for (const n of nodes) {
      const g = groupOf(n);
      if (g === undefined) continue;
      let group = groups.get(g);
      if (!group) groups.set(g, (group = { members: [], cx: 0, cy: 0, reach: 0 }));
      group.members.push(n);
      group.cx += n.x ?? 0;
      group.cy += n.y ?? 0;
    }
    for (const group of groups.values()) {
      group.cx /= group.members.length;
      group.cy /= group.members.length;
      for (const n of group.members) {
        const dx = group.cx - (n.x ?? 0);
        const dy = group.cy - (n.y ?? 0);
        n.vx = (n.vx ?? 0) + dx * pull * alpha;
        n.vy = (n.vy ?? 0) + dy * pull * alpha;
        group.reach = Math.max(group.reach, Math.hypot(dx, dy) + n.r);
      }
    }
    for (const [id, group] of groups) {
      for (const n of nodes) {
        if (groupOf(n) === id) continue;
        const dx = (n.x ?? 0) - group.cx;
        const dy = (n.y ?? 0) - group.cy;
        const min = group.reach + gap + n.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const k = ((min - d) / d) * push;
        n.vx = (n.vx ?? 0) + dx * k;
        n.vy = (n.vy ?? 0) + dy * k;
      }
    }
  };
  force.initialize = (ns: N[]) => {
    nodes = ns;
  };
  return force;
}

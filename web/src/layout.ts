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
  { pull, gap, push, spacing }: { pull: number; gap: number; push: number; spacing: number },
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
      const count = group.members.length;
      group.cx /= count;
      group.cy /= count;
      for (const n of group.members) {
        const dx = group.cx - (n.x ?? 0);
        const dy = group.cy - (n.y ?? 0);
        n.vx = (n.vx ?? 0) + dx * pull * alpha;
        n.vy = (n.vy ?? 0) + dy * pull * alpha;
        group.reach = Math.max(group.reach, Math.hypot(dx, dy) + n.r);
      }
      // The disc tracks the members' real extent, but capped near the extent a compact group of
      // this size would have. Uncapped, pushing one group's members out of another's disc widens
      // that group, which pushes harder, and with many groups the layout diverges.
      group.reach = Math.min(group.reach, spacing * Math.sqrt(count));
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
        const k = ((min - d) / d) * push * alpha;
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

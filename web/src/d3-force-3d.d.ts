// d3-force-3d ships no types. Only the collide force is used directly; force-graph owns the rest.
declare module 'd3-force-3d' {
  interface CollideForce<N> {
    (alpha: number): void;
    initialize(nodes: N[], ...args: unknown[]): void;
    iterations(n: number): CollideForce<N>;
    strength(s: number): CollideForce<N>;
  }
  export function forceCollide<N>(radius: (node: N) => number): CollideForce<N>;
}

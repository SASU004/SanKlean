/**
 * Programmatic Sankey-style flow geometry — visualization layer only.
 *
 * Builds a filled ribbon with flat vertical ends from two smooth cubic-bezier
 * boundaries. Nothing here touches the domain model: it takes plain
 * anchor points + a width and returns SVG path strings.
 *
 * No chart library, no pre-rendered images, no arrowheads, no rounded caps.
 */

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowCurveOptions {
  /**
   * How far the control handles reach, as a fraction of the horizontal
   * span. Higher = looser S-curves. Default 0.5.
   */
  curvature?: number;
  /**
   * FUTURE SEAM (req: expose control points later): explicit control-handle
   * overrides. When provided, they replace the auto-derived handles, so a
   * future version can store per-edge handles in the diagram and pass them
   * straight through here without changing the ribbon builder.
   */
  controls?: {
    c1?: FlowPoint;
    c2?: FlowPoint;
  };
}

export interface FlowRibbon {
  /** Filled ribbon outline (flat vertical ends, closed geometry). */
  path: string;
  /** Smooth centerline (invisible hit-area, debugging). */
  center: string;
  /** Mid-flow point for the value pill. */
  labelX: number;
  labelY: number;
}

/** Cubic-bezier point at t. Shared by the ribbon builder and label placement. */
export function cubic(p0: FlowPoint, p1: FlowPoint, p2: FlowPoint, p3: FlowPoint, t: number): FlowPoint {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function fmt(n: number): string {
  return Number(n.toFixed(1)).toString();
}

/**
 * Auto control handles for an (source, target) anchor pair: horizontal
 * end-tangents keep the flow glued to the node handles; a minimum reach
 * keeps tight/backward flows round instead of pinched.
 *
 * The edge component uses this both as the fallback curve AND to seed +
 * position the draggable handles, so auto and custom curves share one
 * code path.
 */
export function defaultControls(
  source: FlowPoint,
  target: FlowPoint,
  curvature = 0.5,
): { c1: FlowPoint; c2: FlowPoint } {
  const spanX = Math.abs(target.x - source.x);
  const reach = Math.max(24, spanX * curvature);
  return { c1: { x: source.x + reach, y: source.y }, c2: { x: target.x - reach, y: target.y } };
}

/**
 * Flat-ended Sankey ribbon from two cubic-bezier boundaries plus straight
 * vertical end cuts. Thickness comes from the caller (value-based width);
 * this function only shapes the band.
 *
 * - Upper boundary: source-top → target-top cubic.
 * - Lower boundary: target-bottom → source-bottom cubic (drawn backwards).
 * - Ends closed with straight vertical segments at the anchor x positions,
 *   so the band terminates flush against the vertical node bars.
 * - No arcs, no rounded/semircular caps, no arrowheads, no centerline in
 *   the visible path. The visible path is a closed filled shape; thickness
 *   is geometry, never stroke-width.
 */
export function buildFlowRibbon(
  source: FlowPoint,
  target: FlowPoint,
  width: number,
  options: FlowCurveOptions = {},
): FlowRibbon {
  const w = Math.max(2, width);
  const h = w / 2;
  const { curvature = 0.5, controls } = options;

  const auto = defaultControls(source, target, curvature);
  const c1 = controls?.c1 ?? auto.c1;
  const c2 = controls?.c2 ?? auto.c2;

  // Vertical thickness: both boundaries share the anchor x, offset in y.
  // Control handles shift with their boundary so custom bends keep their
  // shape while the end cuts stay exactly vertical.
  const sTop = { x: source.x, y: source.y - h };
  const sBot = { x: source.x, y: source.y + h };
  const tTop = { x: target.x, y: target.y - h };
  const tBot = { x: target.x, y: target.y + h };
  const c1Top = { x: c1.x, y: c1.y - h };
  const c2Top = { x: c2.x, y: c2.y - h };
  const c1Bot = { x: c1.x, y: c1.y + h };
  const c2Bot = { x: c2.x, y: c2.y + h };

  // Begin exactly at the source bar edge, end exactly at the target bar
  // edge: no gap, no overshoot, no detached connector.
  const path =
    `M ${fmt(sTop.x)} ${fmt(sTop.y)}` +
    ` C ${fmt(c1Top.x)} ${fmt(c1Top.y)}, ${fmt(c2Top.x)} ${fmt(c2Top.y)}, ${fmt(tTop.x)} ${fmt(tTop.y)}` +
    ` L ${fmt(tBot.x)} ${fmt(tBot.y)}` +
    ` C ${fmt(c2Bot.x)} ${fmt(c2Bot.y)}, ${fmt(c1Bot.x)} ${fmt(c1Bot.y)}, ${fmt(sBot.x)} ${fmt(sBot.y)}` +
    ` Z`;

  const center =
    `M ${fmt(source.x)} ${fmt(source.y)} ` +
    `C ${fmt(c1.x)} ${fmt(c1.y)}, ${fmt(c2.x)} ${fmt(c2.y)}, ${fmt(target.x)} ${fmt(target.y)}`;

  const mid = cubic(source, c1, c2, target, 0.5);
  return { path, center, labelX: mid.x, labelY: mid.y };
}

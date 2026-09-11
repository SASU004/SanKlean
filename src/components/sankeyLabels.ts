import { isControlPointPair, type Diagram } from '../domain/types';
import { cubic, defaultControls } from './sankeyGeometry';

/**
 * Deterministic Sankey node-label placement — positioning only.
 *
 * The node itself stays a narrow vertical bar (12px). The name + value
 * render as ONE block outside the bar and outside all ribbons:
 * - source nodes (no incoming) prefer LEFT, downstream prefer RIGHT
 * - on collision, fall back to ABOVE / BELOW, then the opposite side
 * - never moves the node, only the label rect relative to it
 * - pure function of diagram data: no randomness, no DOM measuring,
 *   so renders never jump between frames. Recomputed on every render,
 *   so dragging a node re-evaluates placement live.
 */

export type LabelSide = 'left' | 'right' | 'top' | 'bottom';

export interface LabelLayoutInput {
  barHeights: Map<string, number>;
  widths: Map<string, number>;
  lanes: Map<string, { sourceDy: number; targetDy: number }>;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RibbonSample {
  x: number;
  y: number;
  r: number;
}

export const LABEL_BAR_WIDTH = 12;
const LABEL_GAP = 10;
const RIBBON_CLEARANCE = 5;
const BAR_CLEARANCE = 4;
const LABEL_CLEARANCE = 6;
const RIBBON_SAMPLES = 20;

/** Estimated label-block size (px). No DOM measuring: keeps placement stable. */
export function estimateLabelSize(label: string, value: number): { w: number; h: number } {
  const name = (label || '').trim() || 'Untitled';
  const nameW = name.length * 7.4 + 10;
  const valueW = String(value).length * 7.2 + 10;
  return { w: Math.max(44, Math.ceil(Math.max(nameW, valueW))), h: 37 };
}

function candidateRect(
  barX: number,
  barY: number,
  barH: number,
  size: { w: number; h: number },
  side: LabelSide,
): Rect {
  const cx = barX + LABEL_BAR_WIDTH / 2;
  const cy = barY + barH / 2;
  switch (side) {
    case 'left':
      return { x: barX - LABEL_GAP - size.w, y: cy - size.h / 2, w: size.w, h: size.h };
    case 'right':
      return { x: barX + LABEL_BAR_WIDTH + LABEL_GAP, y: cy - size.h / 2, w: size.w, h: size.h };
    case 'top':
      return { x: cx - size.w / 2, y: barY - LABEL_GAP - size.h, w: size.w, h: size.h };
    case 'bottom':
      return { x: cx - size.w / 2, y: barY + barH + LABEL_GAP, w: size.w, h: size.h };
  }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectCircleOverlap(r: Rect, cx: number, cy: number, radius: number): boolean {
  const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
  const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Resolve one label side per node. Deterministic: nodes are visited in
 * creation order (id tie-break), each side is tried in a fixed preference
 * order, and every geometric test is a pure function of stored positions.
 */
export function resolveLabelPlacements(
  diagram: Diagram,
  layout: LabelLayoutInput,
): Map<string, LabelSide> {
  const barRects = new Map<string, Rect>();
  for (const n of diagram.nodes) {
    const pos = diagram.positions[n.id] ?? { x: 100, y: 100 };
    const h = layout.barHeights.get(n.id) ?? 52;
    barRects.set(n.id, { x: pos.x, y: pos.y, w: LABEL_BAR_WIDTH, h });
  }

  // Ribbon center samples with clearance radius, per connection.
  const ribbonByEdge = new Map<string, RibbonSample[]>();
  for (const c of diagram.connections) {
    const sPos = diagram.positions[c.sourceId];
    const tPos = diagram.positions[c.targetId];
    const sBar = barRects.get(c.sourceId);
    const tBar = barRects.get(c.targetId);
    if (!sPos || !tPos || !sBar || !tBar) continue;
    const lane = layout.lanes.get(c.id) ?? { sourceDy: 0, targetDy: 0 };
    const width = layout.widths.get(c.id) ?? 4;
    const anchorS = { x: sBar.x + LABEL_BAR_WIDTH, y: sBar.y + sBar.h / 2 + lane.sourceDy };
    const anchorT = { x: tBar.x, y: tBar.y + tBar.h / 2 + lane.targetDy };
    const stored = (c as { controlPoints?: unknown }).controlPoints;
    const controls = isControlPointPair(stored)
      ? { c1: { ...stored[0] }, c2: { ...stored[1] } }
      : defaultControls(anchorS, anchorT);
    const r = width / 2 + RIBBON_CLEARANCE;
    const samples: RibbonSample[] = [];
    for (let i = 0; i <= RIBBON_SAMPLES; i += 1) {
      const p = cubic(anchorS, controls.c1, controls.c2, anchorT, i / RIBBON_SAMPLES);
      samples.push({ x: p.x, y: p.y, r });
    }
    ribbonByEdge.set(c.id, samples);
  }
  const allRibbons: RibbonSample[][] = [...ribbonByEdge.values()];

  const incomingCount = new Map<string, number>();
  for (const c of diagram.connections) {
    incomingCount.set(c.targetId, (incomingCount.get(c.targetId) ?? 0) + 1);
  }

  const ordered = [...diagram.nodes].sort((a, b) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const placedRects = new Map<string, Rect>();
  const result = new Map<string, LabelSide>();

  for (const n of ordered) {
    const bar = barRects.get(n.id);
    if (!bar) continue;
    const size = estimateLabelSize(n.label, n.value);
    const isSource = (incomingCount.get(n.id) ?? 0) === 0;
    const order: LabelSide[] = isSource
      ? ['left', 'top', 'bottom', 'right']
      : ['right', 'top', 'bottom', 'left'];

    const candidates = order.map((side) => ({ side, rect: candidateRect(bar.x, bar.y, bar.h, size, side) }));

    const collides = (rect: Rect): boolean => {
      for (const [otherId, otherBar] of barRects) {
        if (otherId === n.id) continue;
        const expanded: Rect = {
          x: otherBar.x - BAR_CLEARANCE,
          y: otherBar.y - BAR_CLEARANCE,
          w: otherBar.w + BAR_CLEARANCE * 2,
          h: otherBar.h + BAR_CLEARANCE * 2,
        };
        if (rectsOverlap(rect, expanded)) return true;
      }
      for (const samples of allRibbons) {
        for (const s of samples) {
          if (rectCircleOverlap(rect, s.x, s.y, s.r)) return true;
        }
      }
      for (const other of placedRects.values()) {
        const expanded: Rect = {
          x: other.x - LABEL_CLEARANCE,
          y: other.y - LABEL_CLEARANCE,
          w: other.w + LABEL_CLEARANCE * 2,
          h: other.h + LABEL_CLEARANCE * 2,
        };
        if (rectsOverlap(rect, expanded)) return true;
      }
      return false;
    };

    let chosen = candidates.find((c) => !collides(c.rect));
    if (!chosen) {
      // Every side overlaps something: pick the least-bad side so the value
      // always stays visible. Cost is deterministic; ties keep preference order.
      let best = candidates[0];
      let bestCost = Number.POSITIVE_INFINITY;
      if (!best) continue;
      for (const c of candidates) {
        let cost = 0;
        for (const [otherId, otherBar] of barRects) {
          if (otherId === n.id) continue;
          if (rectsOverlap(c.rect, otherBar)) cost += 10000;
        }
        for (const samples of allRibbons) {
          for (const s of samples) {
            if (rectCircleOverlap(c.rect, s.x, s.y, s.r)) cost += 50;
          }
        }
        for (const other of placedRects.values()) {
          if (rectsOverlap(c.rect, other)) cost += 5000;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = c;
        }
      }
      chosen = best;
    }

    if (chosen) {
      result.set(n.id, chosen.side);
      placedRects.set(n.id, chosen.rect);
    }
  }

  return result;
}

import type { Edge, Node } from '@xyflow/react';
import {
  autoColorForId,
  effectiveFlowValue,
  incomingConnections,
  type Diagram,
  type FlowConnection,
} from '../domain/types';
import { MAX_VALUE, MIN_VALUE } from '../domain/numbers';
import type { LabelSide } from '../components/sankeyLabels';
import { resolveLabelPlacements } from '../components/sankeyLabels';

/**
 * Adapter layer: translates OUR domain model <-> React Flow representation.
 * Application logic must never import RF types directly — always go through here.
 * This keeps us free to swap the canvas library later.
 *
 * The Sankey look (ribbon width, stacked lanes, bar heights, flow color) is
 * derived here from domain data on every render — the domain model itself is
 * untouched. The renderer knows only source/target/value/geometry/color:
 * no label semantics, no hard-coded examples.
 *
 * V1 value model: a one-parent child's value IS its incoming flow
 * (derived at render via `effectiveFlowValue`); a parent's children may
 * never total more than the parent (enforced in the store, silently —
 * leftover unallocated capacity is valid and shows no warning).
 */

export interface FlowNodeData extends Record<string, unknown> {
  domainId: string;
  label: string;
  /** Manual node value — the displayed number. Never derived. */
  value: number;
  color: string;
  /**
   * Rendered bar height (px). Grows to fit the node's stacked flows so
   * bands always land on the visible bar; isolated nodes use BAR_MIN_HEIGHT.
   */
  barHeight: number;
  /**
   * Deterministic label-block side, resolved from node positions + ribbon
   * geometry on every render. Positioning only — never affects values,
   * widths, or layout.
   */
  labelSide: LabelSide;
}

export interface SankeyEdgeData extends Record<string, unknown> {
  domainId: string;
  /** Effective flow (derived from the child for one-parent flows). */
  value: number;
  label?: string;
  /**
   * True when the target has exactly one parent: the value shown is
   * derived from the child node and must not be edited on the edge.
   * False (multi-parent) keeps the stored, editable edge value.
   */
  derived: boolean;
  /** Flow color, inherited from the source node so flows stay distinguishable. */
  color: string;
  /** Final rendered ribbon width (px) after diagram-wide normalization. */
  width: number;
  /**
   * Vertical lane offsets (px) applied to the source/target anchors.
   * Stacked (not clamped) so sibling flows sit edge-to-edge instead of
   * overlapping. Derived view state — never stored in the domain.
   */
  sourceDy: number;
  targetDy: number;
}

export type RFNode = Node<FlowNodeData, 'flowNode'>;
export type RFEdge = Edge<SankeyEdgeData, 'sankey'>;

const DEFAULT_COLOR = '#6366f1';

/** Pixels of ribbon width per unit of flow value (absolute scale). */
const PX_PER_UNIT = 0.9;
/** Minimum visible width for any positive flow (value 1 stays visible). */
const MIN_FLOW_WIDTH = 4;
/** Hairline for zero-value flows (still clickable via the hit-area). */
const ZERO_FLOW_WIDTH = 3;
/**
 * Widest any ribbon may render. When the diagram's largest absolute width
 * exceeds this, EVERY flow is scaled down by one uniform factor, so
 * relative ratios stay exact while the canvas stays usable
 * (7000 vs 2500 vs 500 keeps its 14 : 5 : 1 proportions, just fitted).
 */
const MAX_FLOW_WIDTH = 72;
/** Breathing room between adjacent stacked bands sharing one side of a node. */
const STACK_GAP = 6;

/** Resting bar height for nodes with no (or tiny) flows. */
export const BAR_MIN_HEIGHT = 52;
/** Padding added around a node's tallest flow stack. */
const BAR_PAD = 12;
/** Tallest a bar may grow; taller stacks compress offsets instead. */
const BAR_MAX_HEIGHT = 260;

function clampFlowValue(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(MAX_VALUE, Math.max(MIN_VALUE, Math.round(raw)));
  }
  return 0;
}

/**
 * Absolute ribbon width for one flow value — strictly proportional above
 * the visibility floor: 20 renders exactly 2x 10 and 4x 5, 60 exactly 2x
 * 30, 40 exactly 2x 20. Diagram-wide fitting (see layoutDiagramFlows)
 * only ever scales all flows by one shared factor, so in-diagram ratios
 * are preserved exactly.
 */
export function edgeThickness(value: number): number {
  const v = clampFlowValue(value);
  if (v <= 0) return ZERO_FLOW_WIDTH;
  return Math.max(MIN_FLOW_WIDTH, v * PX_PER_UNIT);
}

function byStableOrder(a: FlowConnection, b: FlowConnection): number {
  // Deterministic flow order: creation order, id as a stable tie-break.
  // The same diagram never rearranges its flows between renders/reloads.
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface DiagramFlowLayout {
  /** Final rendered width per connection id. */
  widths: Map<string, number>;
  /** Stacked anchor offsets per connection id. */
  lanes: Map<string, { sourceDy: number; targetDy: number }>;
  /** Rendered bar height per node id. */
  barHeights: Map<string, number>;
}

/**
 * Diagram-wide Sankey layout, recomputed from domain data on every render:
 *
 * 1. Effective widths from each connection's EFFECTIVE flow
 *    (single-parent: target node value; multi-parent: stored edge value).
 * 2. One uniform downscale if the widest exceeds MAX_FLOW_WIDTH —
 *    adapts to the values present (1/10/100 and 7000/2500/500 both stay
 *    usable) without ever distorting relative thickness.
 * 3. Per-node stacking: each side's flows occupy contiguous segments sized
 *    by their rendered widths, so larger flows own larger portions of the
 *    bar and siblings never overlap. Outgoing siblings order by their
 *    target's vertical canvas position (creation order tie-break);
 *    incoming siblings order by their source's vertical position
 *    (creation order tie-break). Dragging a target/source above its
 *    sibling reorders that side's stack so bands stay uncrossed.
 * 4. Bar heights fit the node's tallest side; overflow beyond BAR_MAX_HEIGHT
 *    compresses offsets rather than growing forever.
 *
 * Pure function of (connections, node ids, positions) — generic over any
 * labels. No auto-layout: node positions are never moved, only each flow's
 * attachment offset on its bars is derived.
 */
export function layoutDiagramFlows(diagram: Diagram): DiagramFlowLayout {
  const connections = diagram.connections;

  // 1–2. Effective widths + uniform fit-to-canvas scale.
  const absolute = new Map<string, number>();
  let maxAbsolute = 0;
  for (const c of connections) {
    const w = edgeThickness(effectiveFlowValue(diagram, c));
    absolute.set(c.id, w);
    if (w > maxAbsolute) maxAbsolute = w;
  }
  const scale = maxAbsolute > MAX_FLOW_WIDTH ? MAX_FLOW_WIDTH / maxAbsolute : 1;
  const widths = new Map<string, number>();
  for (const c of connections) {
    const v = clampFlowValue(effectiveFlowValue(diagram, c));
    const w = absolute.get(c.id) ?? MIN_FLOW_WIDTH;
    widths.set(c.id, v <= 0 ? ZERO_FLOW_WIDTH : Math.max(MIN_FLOW_WIDTH, w * scale));
  }

  // Group sibling flows per side (unsorted here; each side sorts below
  // by canvas Y so bands follow the spatial arrangement of neighbours).
  const groupBy = (key: (c: FlowConnection) => string): Map<string, FlowConnection[]> => {
    const map = new Map<string, FlowConnection[]>();
    for (const c of connections) {
      const k = key(c);
      const list = map.get(k);
      if (list) list.push(c);
      else map.set(k, [c]);
    }
    return map;
  };
  const outgoing = groupBy((c) => c.sourceId);
  const incoming = groupBy((c) => c.targetId);

  // Deterministic spatial ordering. Reads stored canvas Y positions only —
  // never moves nodes. Equal/missing Y falls back to creation order, so the
  // same diagram never reshuffles between renders; dragging a neighbour
  // above its sibling reorders that side's stack live.
  const posY = (nodeId: string): number => {
    const y = diagram.positions[nodeId]?.y;
    return typeof y === 'number' && Number.isFinite(y) ? y : 100;
  };
  for (const list of outgoing.values()) {
    list.sort((a, b) => {
      const ya = posY(a.targetId);
      const yb = posY(b.targetId);
      if (ya !== yb) return ya - yb;
      return byStableOrder(a, b);
    });
  }
  for (const list of incoming.values()) {
    list.sort((a, b) => {
      const ya = posY(a.sourceId);
      const yb = posY(b.sourceId);
      if (ya !== yb) return ya - yb;
      return byStableOrder(a, b);
    });
  }

  // 3. Stack each side: contiguous segments, width-sized, GAP-separated.
  const stackSide = (lists: Map<string, FlowConnection[]>): Map<string, number> => {
    const offsets = new Map<string, number>();
    for (const list of lists.values()) {
      const ws = list.map((c) => widths.get(c.id) ?? MIN_FLOW_WIDTH);
      const total = ws.reduce((a, b) => a + b, 0) + STACK_GAP * Math.max(0, ws.length - 1);
      // Overflow guard: compress positions (never widths) to fit the tallest bar.
      const fit = total > BAR_MAX_HEIGHT - BAR_PAD ? (BAR_MAX_HEIGHT - BAR_PAD) / total : 1;
      let cursor = (-total / 2) * fit;
      list.forEach((c, i) => {
        const w = ws[i] ?? MIN_FLOW_WIDTH;
        offsets.set(c.id, cursor + (w / 2) * fit);
        cursor += (w + STACK_GAP) * fit;
      });
    }
    return offsets;
  };
  const sourceOffsets = stackSide(outgoing);
  const targetOffsets = stackSide(incoming);

  const stackTotal = (list: FlowConnection[] | undefined): number => {
    if (!list || list.length === 0) return 0;
    return (
      list.reduce((a, c) => a + (widths.get(c.id) ?? MIN_FLOW_WIDTH), 0) +
      STACK_GAP * (list.length - 1)
    );
  };

  // 4. Bars fit the node's tallest side so bands land on the visible bar.
  const barHeights = new Map<string, number>();
  for (const n of diagram.nodes) {
    const tallest = Math.max(
      stackTotal(outgoing.get(n.id)),
      stackTotal(incoming.get(n.id)),
    );
    barHeights.set(
      n.id,
      tallest <= 0
        ? BAR_MIN_HEIGHT
        : Math.min(BAR_MAX_HEIGHT, Math.max(BAR_MIN_HEIGHT, tallest + BAR_PAD)),
    );
  }

  const lanes = new Map<string, { sourceDy: number; targetDy: number }>();
  for (const c of connections) {
    lanes.set(c.id, {
      sourceDy: sourceOffsets.get(c.id) ?? 0,
      targetDy: targetOffsets.get(c.id) ?? 0,
    });
  }
  return { widths, lanes, barHeights };
}

export function toReactFlowNodes(
  diagram: Diagram,
  selectedNodeIds: readonly string[] | string | null,
): RFNode[] {
  const layout = layoutDiagramFlows(diagram);
  const placements = resolveLabelPlacements(diagram, layout);
  const selectedSet =
    selectedNodeIds == null
      ? new Set<string>()
      : new Set(Array.isArray(selectedNodeIds) ? selectedNodeIds : [selectedNodeIds]);
  return diagram.nodes.map((n) => {
    const pos = diagram.positions[n.id] ?? { x: 100, y: 100 };
    return {
      id: n.id,
      type: 'flowNode',
      position: { ...pos },
      // Selection is controlled from the store so canvas selection and
      // app state never diverge.
      selected: selectedSet.has(n.id),
      data: {
        domainId: n.id,
        label: n.label,
        // Manual node value only — never derived from flows. Coerced at the
        // domain boundary already; this is a defensive re-coerce for display.
        value:
          typeof n.value === 'number' && Number.isFinite(n.value)
            ? Math.min(MAX_VALUE, Math.max(MIN_VALUE, Math.round(n.value)))
            : 0,
        color: n.color ?? autoColorForId(n.id),
        barHeight: layout.barHeights.get(n.id) ?? BAR_MIN_HEIGHT,
        labelSide: placements.get(n.id) ?? (diagram.connections.some((c) => c.targetId === n.id) ? 'right' : 'left'),
      },
    };
  });
}

export function toReactFlowEdges(
  diagram: Diagram,
  selectedConnectionIds: readonly string[] | string | null,
): RFEdge[] {
  const layout = layoutDiagramFlows(diagram);
  const colorOf = new Map(diagram.nodes.map((n) => [n.id, n.color ?? autoColorForId(n.id)]));
  const selectedSet =
    selectedConnectionIds == null
      ? new Set<string>()
      : new Set(Array.isArray(selectedConnectionIds) ? selectedConnectionIds : [selectedConnectionIds]);
  return diagram.connections.map((c) => {
    const lane = layout.lanes.get(c.id) ?? { sourceDy: 0, targetDy: 0 };
    return {
      id: c.id,
      source: c.sourceId,
      target: c.targetId,
      type: 'sankey',
      selected: selectedSet.has(c.id),
      data: {
        domainId: c.id,
        value: effectiveFlowValue(diagram, c),
        label: c.label,
        derived: incomingConnections(diagram, c.targetId).length === 1,
        color: colorOf.get(c.sourceId) ?? DEFAULT_COLOR,
        width: layout.widths.get(c.id) ?? edgeThickness(effectiveFlowValue(diagram, c)),
        sourceDy: lane.sourceDy,
        targetDy: lane.targetDy,
      },
    };
  });
}

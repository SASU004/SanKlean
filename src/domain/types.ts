/**
 * Sanklean domain model.
 *
 * Deliberately independent from any canvas library (React Flow, etc.).
 * The domain represents an arbitrary directed graph — NOT a tree, NOT
 * hard-coded to job applications. Any labels/values are user-defined.
 * A node may have zero, one, or many parents and children.
 *
 * Extension points (future):
 * - auth / cloud: swap the persistence behind the store's `persist` storage
 * - multiple diagrams: store already uses `diagrams` map + `activeDiagramId`
 * - undo/redo: wrap store actions in a command stack
 * - import/export: Diagram is plain JSON-serializable
 */

import { normalizeConnectionValue, normalizeNodeValue } from './numbers';

export interface FlowNode {
  /** Stable unique id (uuid). */
  id: string;
  /** User-visible name. Arbitrary text. */
  label: string;
  /** User-editable numeric value shown on the node. Defaults to 0. */
  value: number;
  /** Accent color (hex), auto-assigned at creation. */
  color?: string;
  createdAt: number;
}

export interface FlowConnection {
  id: string;
  /** Source node id — any node can connect to any other (cycles allowed). */
  sourceId: string;
  targetId: string;
  /** Optional edge label (reserved for future use). */
  label?: string;
  /**
   * Stored flow magnitude (0..10000 int).
   *
   * This is the source of truth ONLY when the target has multiple parents
   * (allocation across parents is intentionally unsolved in V1).
   * When the target has exactly one parent, the rendered flow is DERIVED
   * from the target node's value (see `effectiveFlowValue`) and this stored
   * number is ignored — the child value must never be duplicated in two
   * editable places.
   */
  value: number;
  /**
   * User-customized curve handles, stored as absolute canvas positions.
   * Absent = auto curve derived from the current node positions.
   * Absolute storage means dragging a node re-anchors the endpoints while
   * the handles stay put, preserving the user's bend as much as possible.
   */
  controlPoints?: [ControlPoint, ControlPoint];
  createdAt: number;
}

/** A bezier control handle position. Plain data — canvas coordinates. */
export interface ControlPoint {
  x: number;
  y: number;
}

/** Type guard for user-supplied curve data (persisted JSON is untrusted). */
export function isControlPointPair(raw: unknown): raw is [ControlPoint, ControlPoint] {
  if (!Array.isArray(raw) || raw.length !== 2) return false;
  return raw.every(
    (p) =>
      typeof p === 'object' &&
      p !== null &&
      Number.isFinite((p as { x?: unknown }).x) &&
      Number.isFinite((p as { y?: unknown }).y),
  );
}

export interface NodePosition {
  x: number;
  y: number;
}

/**
 * Positions are stored SEPARATELY from node values.
 * Rationale: layout is a view concern; label/value are domain concerns.
 * This keeps the graph re-layoutable without touching semantics.
 */
export interface Diagram {
  id: string;
  name: string;
  nodes: FlowNode[];
  connections: FlowConnection[];
  positions: Record<string, NodePosition>;
  updatedAt: number;
}

/** Visually distinct palette cycled through as nodes are created. */
export const NODE_PALETTE = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#14b8a6',
  '#f43f5e',
  '#84cc16',
  '#f97316',
] as const;

/** Deterministic color for the n-th created node. Stable once stored. */
export function colorForIndex(index: number): string {
  return NODE_PALETTE[index % NODE_PALETTE.length];
}

/**
 * Deterministic fallback color derived from a node id.
 * Used for diagrams persisted before colors existed, so old nodes keep
 * a stable color across reloads without a data migration changing ids.
 */
export function autoColorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return NODE_PALETTE[Math.abs(hash) % NODE_PALETTE.length];
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * THE THREE VALUE CONCEPTS
 *
 * 1. Node value (`FlowNode.value`): the user-editable quantity at a stage.
 *    Root nodes are independent. A child with exactly one parent OWNS its
 *    incoming flow — its value IS the flow amount.
 * 2. Connection value (`FlowConnection.value`): stored number, authoritative
 *    ONLY for multi-parent targets (see above). For ordinary one-parent
 *    flows the effective value is derived from the target node and the
 *    stored number is ignored, so the same quantity is never editable in
 *    two places.
 * 3. Effective flow (`effectiveFlowValue()`): what actually flows along an
 *    edge and drives rendering. Parent capacity is enforced over these:
 *    a parent's single-parent children may never total more than the
 *    parent's own value (leftover unallocated capacity is fine and silent).
 */

/** All edges flowing into a node, in deterministic (creation) order. */
export function incomingConnections(diagram: Diagram, nodeId: string): FlowConnection[] {
  return diagram.connections
    .filter((c) => c.targetId === nodeId)
    .sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : 1));
}

/**
 * Effective flow along an edge — the Sankey quantity it carries.
 * Single-parent target: the target node's value (source of truth).
 * Multi-parent target: the stored edge value (V1 fallback; allocation
 * across parents is deliberately unsolved for now).
 * Generic over labels — knows only source/target/value.
 */
export function effectiveFlowValue(diagram: Diagram, conn: FlowConnection): number {
  const stored = normalizeConnectionValue(conn.value as unknown, 0);
  if (incomingConnections(diagram, conn.targetId).length !== 1) return stored;
  const target = diagram.nodes.find((n) => n.id === conn.targetId);
  if (!target) return stored;
  return normalizeNodeValue(target.value as unknown, 0);
}

export function createDiagram(name = 'Untitled flow'): Diagram {
  return {
    id: uid(),
    name,
    nodes: [],
    connections: [],
    positions: {},
    updatedAt: Date.now(),
  };
}

export function createNode(
  label: string,
  position: NodePosition,
  value = 0,
  color?: string,
): {
  node: FlowNode;
  position: NodePosition;
} {
  return {
    node: { id: uid(), label, value: normalizeNodeValue(value, 0), color, createdAt: Date.now() },
    position: { ...position },
  };
}

export function createConnection(
  sourceId: string,
  targetId: string,
  value = 1,
): FlowConnection {
  return {
    id: uid(),
    sourceId,
    targetId,
    value: normalizeConnectionValue(value, 1),
    createdAt: Date.now(),
  };
}

/**
 * Enforce parent capacity over single-parent children — the Sankey quantity
 * invariant. For each parent, children (in edge-creation order) are capped
 * so their total never exceeds the parent's own value:
 *
 * - one child over capacity is clamped to the parent value (400/600 → 400)
 * - a later sibling that doesn't fit is clamped to the remainder
 *   (250 consumed, 200 requested → 150)
 * - an earlier sibling increased past the total pushes later siblings down
 *   (200+200, edit first to 250 → second becomes 150)
 * - leftover unallocated capacity is valid and silent — never a warning
 * - root nodes (no parents) are unconstrained; multi-parent children are
 *   left untouched (allocation unsolved in V1) and don't consume capacity
 *
 * Values only ever decrease, so repeated passes converge (a clamp
 * propagates one chain level per pass; chains are at most N deep).
 * Returns the same reference when nothing changed.
 */
export function enforceParentCapacities(diagram: Diagram): Diagram {
  const incomingCount = new Map<string, number>();
  for (const c of diagram.connections) {
    incomingCount.set(c.targetId, (incomingCount.get(c.targetId) ?? 0) + 1);
  }
  const outgoing = new Map<string, FlowConnection[]>();
  for (const c of diagram.connections) {
    const list = outgoing.get(c.sourceId);
    if (list) list.push(c);
    else outgoing.set(c.sourceId, [c]);
  }
  for (const list of outgoing.values()) {
    list.sort((a, b) =>
      a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : 1,
    );
  }

  const nodes = diagram.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOrder = [...nodes].sort((a, b) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : 1,
  );

  let changedAny = false;
  for (let pass = 0; pass < nodes.length + 1; pass += 1) {
    let changed = false;
    for (const p of parentOrder) {
      const parent = byId.get(p.id);
      if (!parent) continue;
      const list = outgoing.get(p.id);
      if (!list) continue;
      let remaining = parent.value;
      for (const e of list) {
        if ((incomingCount.get(e.targetId) ?? 0) !== 1) continue;
        const child = byId.get(e.targetId);
        if (!child) continue;
        const allowed = Math.max(0, Math.min(child.value, remaining));
        if (allowed !== child.value) {
          child.value = allowed;
          changed = true;
          changedAny = true;
        }
        remaining = Math.max(0, remaining - child.value);
      }
    }
    if (!changed) break;
  }
  if (!changedAny) return diagram;
  return { ...diagram, nodes, updatedAt: Date.now() };
}

/** Normalize persisted data: coerce numeric strings, clamp 0..10000 ints. */
export function normalizeDiagram(diagram: Diagram): Diagram {
  let changed = false;
  const nodes = diagram.nodes.map((n) => {
    // Coerce at the boundary so "31" becomes 31 instead of resetting to 0.
    const value = normalizeNodeValue(n.value as unknown, 0);
    const color = typeof n.color === 'string' && n.color.length > 0 ? n.color : autoColorForId(n.id);
    if (value !== n.value || color !== n.color) {
      changed = true;
      return { ...n, value, color };
    }
    return n;
  });
  const connections = diagram.connections.map((c) => {
    // Same boundary coercion for flows: "14" -> 14, clamped 0..10000 int.
    const value = normalizeConnectionValue(
      (c as { value?: unknown }).value,
      1,
    );
    let next = c;
    if (value !== c.value) {
      changed = true;
      next = { ...next, value };
    }
    if (next.controlPoints !== undefined && !isControlPointPair(next.controlPoints)) {
      changed = true;
      const copy = { ...next };
      delete copy.controlPoints;
      return copy;
    }
    return next;
  });
  const coerced: Diagram = changed
    ? { ...diagram, nodes, connections, updatedAt: Date.now() }
    : diagram;
  // Repair legacy states that violate parent capacity (previously allowed).
  return enforceParentCapacities(coerced);
}

export function isValidDiagram(data: unknown): data is Diagram {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    Array.isArray(d.nodes) &&
    Array.isArray(d.connections) &&
    typeof d.positions === 'object'
  );
}

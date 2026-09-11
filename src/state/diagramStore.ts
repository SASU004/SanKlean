import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { clampInt, coerceToBoundedInt } from '../domain/numbers';
import {
  colorForIndex,
  createConnection,
  createDiagram,
  createNode,
  enforceParentCapacities,
  incomingConnections,
  isControlPointPair,
  isValidDiagram,
  normalizeDiagram,
  type ControlPoint,
  type Diagram,
  type NodePosition,
} from '../domain/types';
import { BAR_MIN_HEIGHT, layoutDiagramFlows } from '../adapters/reactflow';

/**
 * Single-diagram UX for V1, but the state shape is already
 * multi-diagram ready: `diagrams` map + `activeDiagramId`.
 * Future cloud sync only needs to replace the `persist` storage.
 *
 * Session-only UI state (selection, edit focus, undo history) is
 * deliberately NOT persisted — only diagrams + activeDiagramId hit
 * localStorage (autosave).
 *
 * Undo/redo is a snapshot stack over { diagrams, activeDiagramId }.
 * Pointer-drag bursts (node moves, curve drags) coalesce into one entry
 * so a single Ctrl+Z reverts the whole gesture, not every mousemove.
 */

export type EditField = 'label' | 'value';

/** Canvas tools. Hand is the default: infinite whiteboard (pan on empty canvas).
 * Selector is secondary, for marquee group selection + group deletion only. */
export type CanvasTool = 'hand' | 'select';

interface HistoryEntry {
  diagrams: Record<string, Diagram>;
  activeDiagramId: string;
}

interface NodePatch {
  label?: string;
  value?: number;
}

interface ConnectionPatch {
  value?: number;
  label?: string;
  controlPoints?: [ControlPoint, ControlPoint] | null;
}

interface DiagramState {
  diagrams: Record<string, Diagram>;
  activeDiagramId: string;
  /** Primary selected node (toolbar target). Last-selected of the set. */
  selectedNodeId: string | null;
  /** Full multi-selection set (insertion order). Single clicks replace it. */
  selectedNodeIds: string[];
  selectedConnectionId: string | null;
  /** Full multi-selection set for ribbons (insertion order). */
  selectedConnectionIds: string[];
  /** Active canvas tool. Hand is always the default (including after refresh). */
  activeTool: CanvasTool;
  /** Node whose inline editor should open (null = none). */
  editingNodeId: string | null;
  editingField: EditField;
  past: HistoryEntry[];
  future: HistoryEntry[];

  activeDiagram: () => Diagram;

  addNode: (label?: string, position?: NodePosition) => string;
  /** Create a node next to `parentId` and connect parent → child. */
  addChild: (parentId: string) => string | null;
  updateNode: (id: string, patch: NodePatch) => void;
  moveNode: (id: string, position: NodePosition) => void;
  removeNode: (id: string) => void;
  /** Delete several nodes + their attached connections in ONE undo step. */
  removeNodes: (ids: string[]) => void;

  addConnection: (sourceId: string, targetId: string, value?: number) => string | null;
  updateConnection: (id: string, patch: ConnectionPatch) => void;
  removeConnection: (id: string) => void;
  /** Delete several connections in ONE undo step. */
  removeConnections: (ids: string[]) => void;
  /** Delete the current node/ribbon selection in ONE undo step. */
  deleteSelected: () => void;

  renameDiagram: (name: string) => void;
  clearDiagram: () => void;
  replaceDiagram: (diagram: Diagram) => void;

  undo: () => void;
  redo: () => void;

  setSelection: (nodeId: string | null, connectionId: string | null) => void;
  /**
   * Replace the full canvas selection (nodes + ribbons) from a single
   * React Flow selection snapshot. Used for click / Shift-click /
   * Shift-drag marquee so plain clicks replace and Shift accumulates
   * exactly as the canvas reports it.
   */
  setCanvasSelection: (nodeIds: string[], connectionIds: string[]) => void;
  setActiveTool: (tool: CanvasTool) => void;
  setEditingNode: (nodeId: string | null, field?: EditField) => void;
}

const HISTORY_LIMIT = 50;
/** Window in which consecutive drag writes merge into one history entry. */
const TRANSIENT_WINDOW_MS = 800;
const TRANSIENT_TYPES = new Set(['move-node', 'curve-drag']);

function initial(): { diagrams: Record<string, Diagram>; activeDiagramId: string } {
  const d = createDiagram('My first flow');
  return { diagrams: { [d.id]: d }, activeDiagramId: d.id };
}

/**
 * Placement/spacing helpers — positioning only. They choose where NEW nodes
 * land so bars never stack directly on each other. Existing node positions
 * are inputs, never outputs: nothing here moves an already-placed node,
 * arranges the graph, or touches values, colors, or geometry.
 */

/** Narrow Sankey bar width (px). Must match the rendered `.sankey-bar`. */
const PLACE_BAR_WIDTH = 12;
/** Fresh nodes have no flows yet, so they rest at the minimum bar height. */
const PLACE_NEW_BAR_HEIGHT = BAR_MIN_HEIGHT;
/** Breathing room around each bar when testing a candidate spot. */
const PLACE_PAD_X = 24;
const PLACE_PAD_Y = 24;
/** Deterministic nudge grid used only when the desired spot is occupied. */
const PLACE_SCAN_STEP = 48;
const PLACE_SCAN_RADIUS = 10;
/** Child placement: horizontal gap from the parent + sibling row height. */
const CHILD_GAP_X = 260;
const CHILD_STEP_Y = 150;

interface PlaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function placeRectsOverlap(a: PlaceRect, b: PlaceRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Bar boxes (with breathing room) for every node already on the canvas. */
function occupiedBarRects(diagram: Diagram): PlaceRect[] {
  const layout = layoutDiagramFlows(diagram);
  return diagram.nodes.map((n) => {
    const pos = diagram.positions[n.id] ?? { x: 100, y: 100 };
    const h = layout.barHeights.get(n.id) ?? BAR_MIN_HEIGHT;
    return {
      x: pos.x - PLACE_PAD_X,
      y: pos.y - PLACE_PAD_Y,
      w: PLACE_BAR_WIDTH + PLACE_PAD_X * 2,
      h: h + PLACE_PAD_Y * 2,
    };
  });
}

/**
 * Returns `desired` verbatim when its bar box is clear; otherwise the
 * nearest deterministic nudge (vertical-first scan, so left→right Sankey
 * progression is preserved) that clears every existing bar. Only ever
 * positions the incoming node — existing nodes are never moved.
 */
function findFreeSpot(
  occupied: PlaceRect[],
  desired: NodePosition,
  barHeight: number,
): NodePosition {
  const box = (x: number, y: number): PlaceRect => ({
    x: x - PLACE_PAD_X,
    y: y - PLACE_PAD_Y,
    w: PLACE_BAR_WIDTH + PLACE_PAD_X * 2,
    h: barHeight + PLACE_PAD_Y * 2,
  });
  const isFree = (x: number, y: number): boolean => {
    const b = box(x, y);
    return !occupied.some((o) => placeRectsOverlap(b, o));
  };
  if (isFree(desired.x, desired.y)) return { ...desired };
  for (let r = 1; r <= PLACE_SCAN_RADIUS; r += 1) {
    const d = r * PLACE_SCAN_STEP;
    if (isFree(desired.x, desired.y + d)) return { x: desired.x, y: desired.y + d };
    if (isFree(desired.x, desired.y - d)) return { x: desired.x, y: desired.y - d };
    if (isFree(desired.x + d, desired.y)) return { x: desired.x + d, y: desired.y };
    if (isFree(desired.x - d, desired.y)) return { x: desired.x - d, y: desired.y };
  }
  return { x: desired.x, y: desired.y + PLACE_SCAN_RADIUS * PLACE_SCAN_STEP };
}

export const useDiagramStore = create<DiagramState>()(
  persist(
    (set, get) => {
      let lastEdit: { type: string; time: number } = { type: '', time: 0 };

      /**
       * Apply a diagram mutation as ONE undoable step. Drag bursts of the
       * same transient type coalesce; every other action pushes a step and
       * clears the redo stack.
       */
      const commit = (
        type: string,
        apply: (s: DiagramState) => Partial<DiagramState>,
      ): void => {
        const prev = get();
        const now = Date.now();
        const coalesce =
          TRANSIENT_TYPES.has(type) && lastEdit.type === type && now - lastEdit.time < TRANSIENT_WINDOW_MS;
        lastEdit = { type, time: now };
        set({
          ...apply(prev),
          past: coalesce
            ? prev.past
            : [
                ...prev.past.slice(-HISTORY_LIMIT + 1),
                { diagrams: prev.diagrams, activeDiagramId: prev.activeDiagramId },
              ],
          future: [],
        });
      };

      const active = (s: DiagramState): Diagram =>
        s.diagrams[s.activeDiagramId] ?? Object.values(s.diagrams)[0];

      return {
        ...initial(),
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedConnectionId: null,
        selectedConnectionIds: [],
        activeTool: 'hand',
        editingNodeId: null,
        editingField: 'label',
        past: [],
        future: [],

        activeDiagram: () => {
          const s = get();
          // Defensive fallback: persisted state may reference a missing id.
          return active(s);
        },

        addNode: (label, position) => {
          const s = get();
          const diagram = active(s);
          const offset = diagram.nodes.length;
          // Default slot follows the long-standing staggered pattern, but the
          // final spot always dodges existing bars (user-moved nodes included)
          // instead of landing directly on top of another node.
          const fallback = {
            x: 120 + (offset % 6) * 180,
            y: 120 + Math.floor(offset / 6) * 140,
          };
          const wanted = position ?? fallback;
          const pos = findFreeSpot(occupiedBarRects(diagram), wanted, PLACE_NEW_BAR_HEIGHT);
          const { node } = createNode(
            label ?? `Node ${offset + 1}`,
            pos,
            0,
            colorForIndex(offset),
          );
          commit('add-node', (prev) => ({
            diagrams: {
              ...prev.diagrams,
              [diagram.id]: {
                ...diagram,
                nodes: [...diagram.nodes, node],
                positions: { ...diagram.positions, [node.id]: pos },
                updatedAt: Date.now(),
              },
            },
            selectedNodeId: node.id,
            selectedNodeIds: [node.id],
            selectedConnectionId: null,
            selectedConnectionIds: [],
            editingNodeId: node.id,
            editingField: 'label',
          }));
          return node.id;
        },

        addChild: (parentId) => {
          const s = get();
          const diagram = active(s);
          if (!diagram.nodes.some((n) => n.id === parentId)) return null;
          const parentPos = diagram.positions[parentId] ?? { x: 120, y: 120 };
          // Right of the parent with a clear horizontal gap; each sibling
          // starts one row lower so bars/labels/ribbons stay distinguishable.
          // The final spot additionally dodges every existing bar (moved
          // siblings or unrelated nodes included) — existing nodes never move.
          const siblings = diagram.connections.filter((c) => c.sourceId === parentId).length;
          const wanted = { x: parentPos.x + CHILD_GAP_X, y: parentPos.y + siblings * CHILD_STEP_Y };
          const pos = findFreeSpot(occupiedBarRects(diagram), wanted, PLACE_NEW_BAR_HEIGHT);
          const { node } = createNode('New Node', pos, 0, colorForIndex(diagram.nodes.length));
          const conn = createConnection(parentId, node.id, 1);
          // A zero-valued child never violates capacity, but enforce for
          // uniformity (idempotent when already valid).
          const grown = enforceParentCapacities({
            ...diagram,
            nodes: [...diagram.nodes, node],
            connections: [...diagram.connections, conn],
          });
          commit('add-child', (prev) => ({
            diagrams: {
              ...prev.diagrams,
              [diagram.id]: {
                ...grown,
                positions: { ...diagram.positions, [node.id]: pos },
                updatedAt: Date.now(),
              },
            },
            selectedNodeId: node.id,
            selectedNodeIds: [node.id],
            selectedConnectionId: null,
            selectedConnectionIds: [],
            editingNodeId: node.id,
            editingField: 'label',
          }));
          return node.id;
        },

        updateNode: (id, patch) => {
          const s = get();
          const diagram = active(s);
          commit('edit-node', (prev) => {
            const nodes = diagram.nodes.map((n) =>
              n.id === id
                ? {
                    ...n,
                    ...(patch.label !== undefined ? { label: patch.label } : {}),
                    // Requested value, 0..10000 int. Strings coerce
                    // ("31" -> 31); invalid drafts are ignored, never truncated.
                    ...(patch.value !== undefined
                      ? (() => {
                          const coerced = coerceToBoundedInt(patch.value as unknown);
                          return coerced !== null ? { value: clampInt(coerced) } : {};
                        })()
                      : {}),
                  }
                : n,
            );
            // Sankey capacity: the requested value may be clamped down, and
            // siblings/descendants rebalanced, so children never total more
            // than their parent. Unallocated remainder is valid and silent.
            const enforced = enforceParentCapacities({ ...diagram, nodes });
            return {
              diagrams: {
                ...prev.diagrams,
                [diagram.id]: { ...enforced, updatedAt: Date.now() },
              },
            };
          });
        },

        moveNode: (id, position) => {
          const s = get();
          const diagram = active(s);
          if (!diagram.nodes.some((n) => n.id === id)) return;
          commit('move-node', (prev) => ({
            diagrams: {
              ...prev.diagrams,
              [diagram.id]: {
                ...diagram,
                positions: { ...diagram.positions, [id]: { ...position } },
                updatedAt: Date.now(),
              },
            },
          }));
        },

        removeNode: (id) => {
          const s = get();
          const diagram = active(s);
          // A selected connection attached to the deleted node must go too —
          // otherwise the selection would point at a connection that no longer exists.
          const dyingEdgeIds = new Set(
            diagram.connections
              .filter((c) => c.sourceId === id || c.targetId === id)
              .map((c) => c.id),
          );
          commit('remove-node', (prev) => {
            const pruned: Diagram = {
              ...diagram,
              nodes: diagram.nodes.filter((n) => n.id !== id),
              connections: diagram.connections.filter((c) => c.sourceId !== id && c.targetId !== id),
              positions: Object.fromEntries(Object.entries(diagram.positions).filter(([k]) => k !== id)),
            };
            // Removing a node can turn a multi-parent child into a
            // single-parent one, newly subject to capacity — re-enforce.
            const enforced = enforceParentCapacities(pruned);
            const remainingIds = prev.selectedNodeIds.filter((nid) => nid !== id);
            const remainingEdgeIds = prev.selectedConnectionIds.filter((eid) => !dyingEdgeIds.has(eid));
            return {
              diagrams: {
                ...prev.diagrams,
                [diagram.id]: { ...enforced, updatedAt: Date.now() },
              },
              selectedNodeId:
                prev.selectedNodeId === id
                  ? (remainingIds.length > 0 ? remainingIds[remainingIds.length - 1]! : null)
                  : prev.selectedNodeId,
              selectedNodeIds: remainingIds,
              selectedConnectionIds: remainingEdgeIds,
              selectedConnectionId:
                prev.selectedConnectionId !== null && dyingEdgeIds.has(prev.selectedConnectionId)
                  ? (remainingEdgeIds.length > 0
                      ? remainingEdgeIds[remainingEdgeIds.length - 1]!
                      : null)
                  : prev.selectedConnectionId,
              editingNodeId: prev.editingNodeId === id ? null : prev.editingNodeId,
            };
          });
        },

        removeNodes: (ids) => {
          const s = get();
          const diagram = active(s);
          const doomed = new Set(ids.filter((id) => diagram.nodes.some((n) => n.id === id)));
          if (doomed.size === 0) return;
          const dyingEdgeIds = new Set(
            diagram.connections
              .filter((c) => doomed.has(c.sourceId) || doomed.has(c.targetId))
              .map((c) => c.id),
          );
          commit('remove-node', (prev) => {
            const pruned: Diagram = {
              ...diagram,
              nodes: diagram.nodes.filter((n) => !doomed.has(n.id)),
              connections: diagram.connections.filter(
                (c) => !doomed.has(c.sourceId) && !doomed.has(c.targetId),
              ),
              positions: Object.fromEntries(
                Object.entries(diagram.positions).filter(([k]) => !doomed.has(k)),
              ),
            };
            const enforced = enforceParentCapacities(pruned);
            const remaining = prev.selectedNodeIds.filter((nid) => !doomed.has(nid));
            const remainingEdgeIds = prev.selectedConnectionIds.filter((eid) => !dyingEdgeIds.has(eid));
            return {
              diagrams: {
                ...prev.diagrams,
                [diagram.id]: { ...enforced, updatedAt: Date.now() },
              },
              selectedNodeId:
                prev.selectedNodeId !== null && !doomed.has(prev.selectedNodeId)
                  ? prev.selectedNodeId
                  : (remaining.length > 0 ? remaining[remaining.length - 1]! : null),
              selectedNodeIds: remaining,
              selectedConnectionIds: remainingEdgeIds,
              selectedConnectionId:
                prev.selectedConnectionId !== null && dyingEdgeIds.has(prev.selectedConnectionId)
                  ? (remainingEdgeIds.length > 0
                      ? remainingEdgeIds[remainingEdgeIds.length - 1]!
                      : null)
                  : prev.selectedConnectionId,
              editingNodeId:
                prev.editingNodeId !== null && doomed.has(prev.editingNodeId)
                  ? null
                  : prev.editingNodeId,
            };
          });
        },

        addConnection: (sourceId, targetId, value = 1) => {
          const s = get();
          const diagram = active(s);
          if (sourceId === targetId) return null;
          if (!diagram.nodes.some((n) => n.id === sourceId)) return null;
          if (!diagram.nodes.some((n) => n.id === targetId)) return null;
          // Prevent accidental duplicates: one edge per ordered pair in V1.
          if (diagram.connections.some((c) => c.sourceId === sourceId && c.targetId === targetId)) {
            return null;
          }
          const conn = createConnection(sourceId, targetId, value);
          // Attaching a valued child to a new parent can exceed that
          // parent's remaining capacity — the newcomer (newest edge) is
          // clamped to the remainder by the same sibling-order rule.
          const grown = enforceParentCapacities({
            ...diagram,
            connections: [...diagram.connections, conn],
          });
          commit('add-edge', (prev) => ({
            diagrams: {
              ...prev.diagrams,
              [diagram.id]: {
                ...grown,
                updatedAt: Date.now(),
              },
            },
            selectedConnectionId: conn.id,
            selectedConnectionIds: [conn.id],
            selectedNodeId: null,
            selectedNodeIds: [],
          }));
          return conn.id;
        },

        updateConnection: (id, patch) => {
          const s = get();
          const diagram = active(s);
          const type = patch.controlPoints !== undefined && patch.controlPoints !== null ? 'curve-drag' : 'edit-edge';
          // Single-parent flows are derived from the child value — an
          // independently edited edge number must not exist in that mode,
          // so value patches there are dropped (label/curve still apply).
          const targetSingleParent =
            patch.value !== undefined
              ? (() => {
                  const conn = diagram.connections.find((c) => c.id === id);
                  return conn ? incomingConnections(diagram, conn.targetId).length === 1 : false;
                })()
              : false;
          commit(type, (prev) => ({
            diagrams: {
              ...prev.diagrams,
              [diagram.id]: {
                ...diagram,
                connections: diagram.connections.map((c) => {
                  if (c.id !== id) return c;
                  const next = {
                    ...c,
                    ...(patch.label !== undefined ? { label: patch.label } : {}),
                    // Stored flow value, 0..10000 int (multi-parent targets
                    // only — dropped for derived single-parent flows above).
                    // 0 is valid (hairline); invalid drafts keep the old value.
                    ...(patch.value !== undefined && !targetSingleParent
                      ? (() => {
                          const coerced = coerceToBoundedInt(patch.value as unknown);
                          return coerced !== null ? { value: clampInt(coerced) } : {};
                        })()
                      : {}),
                  };
                  if (patch.controlPoints !== undefined) {
                    if (patch.controlPoints === null) {
                      delete next.controlPoints;
                    } else if (isControlPointPair(patch.controlPoints)) {
                      // Copy so later UI mutations can't alias stored state.
                      next.controlPoints = [{ ...patch.controlPoints[0] }, { ...patch.controlPoints[1] }];
                    }
                  }
                  return next;
                }),
                updatedAt: Date.now(),
              },
            },
          }));
        },

        removeConnection: (id) => {
          const s = get();
          const diagram = active(s);
          if (!diagram.connections.some((c) => c.id === id)) return;
          const pruned: Diagram = {
            ...diagram,
            connections: diagram.connections.filter((c) => c.id !== id),
          };
          // Dropping a parent edge can leave a child newly single-parented
          // (capacity now applies) — re-enforce inside the same undo step.
          const enforced = enforceParentCapacities(pruned);
          commit('remove-edge', (prev) => {
            const remainingEdgeIds = prev.selectedConnectionIds.filter((eid) => eid !== id);
            return {
              diagrams: {
                ...prev.diagrams,
                [diagram.id]: { ...enforced, updatedAt: Date.now() },
              },
              selectedConnectionIds: remainingEdgeIds,
              selectedConnectionId:
                prev.selectedConnectionId === id
                  ? (remainingEdgeIds.length > 0
                      ? remainingEdgeIds[remainingEdgeIds.length - 1]!
                      : null)
                  : prev.selectedConnectionId,
            };
          });
        },

        removeConnections: (ids) => {
          const s = get();
          const diagram = active(s);
          const doomed = new Set(ids.filter((id) => diagram.connections.some((c) => c.id === id)));
          if (doomed.size === 0) return;
          const pruned: Diagram = {
            ...diagram,
            connections: diagram.connections.filter((c) => !doomed.has(c.id)),
          };
          const enforced = enforceParentCapacities(pruned);
          commit('remove-edge', (prev) => {
            const remainingEdgeIds = prev.selectedConnectionIds.filter((eid) => !doomed.has(eid));
            return {
              diagrams: {
                ...prev.diagrams,
                [diagram.id]: { ...enforced, updatedAt: Date.now() },
              },
              selectedConnectionIds: remainingEdgeIds,
              selectedConnectionId:
                prev.selectedConnectionId !== null && doomed.has(prev.selectedConnectionId)
                  ? (remainingEdgeIds.length > 0
                      ? remainingEdgeIds[remainingEdgeIds.length - 1]!
                      : null)
                  : prev.selectedConnectionId,
            };
          });
        },

        deleteSelected: () => {
          const s = get();
          const diagram = active(s);
          const doomedNodes = new Set(
            s.selectedNodeIds.filter((id) => diagram.nodes.some((n) => n.id === id)),
          );
          const explicitEdges = new Set([
            ...s.selectedConnectionIds,
            ...(s.selectedConnectionId !== null ? [s.selectedConnectionId] : []),
          ]);
          const doomedEdges = new Set(
            [...explicitEdges].filter((id) => diagram.connections.some((c) => c.id === id)),
          );
          if (doomedNodes.size === 0 && doomedEdges.size === 0) return;
          commit('delete-selected', (prev) => {
            const pruned: Diagram = {
              ...diagram,
              nodes: diagram.nodes.filter((n) => !doomedNodes.has(n.id)),
              // Deleting a node removes all attached connections; deleting a
              // ribbon removes only that connection. Never orphan connections.
              connections: diagram.connections.filter(
                (c) =>
                  !doomedNodes.has(c.sourceId) &&
                  !doomedNodes.has(c.targetId) &&
                  !doomedEdges.has(c.id),
              ),
              positions: Object.fromEntries(
                Object.entries(diagram.positions).filter(([k]) => !doomedNodes.has(k)),
              ),
            };
            const enforced = enforceParentCapacities(pruned);
            const remainingNodes = prev.selectedNodeIds.filter((nid) => !doomedNodes.has(nid));
            const attachedDies = new Set(
              diagram.connections
                .filter((c) => doomedNodes.has(c.sourceId) || doomedNodes.has(c.targetId))
                .map((c) => c.id),
            );
            const deadEdges = new Set([...doomedEdges, ...attachedDies]);
            const remainingEdges = prev.selectedConnectionIds.filter((eid) => !deadEdges.has(eid));
            return {
              diagrams: {
                ...prev.diagrams,
                [diagram.id]: { ...enforced, updatedAt: Date.now() },
              },
              selectedNodeIds: remainingNodes,
              selectedNodeId:
                prev.selectedNodeId !== null && doomedNodes.has(prev.selectedNodeId)
                  ? (remainingNodes.length > 0 ? remainingNodes[remainingNodes.length - 1]! : null)
                  : prev.selectedNodeId,
              selectedConnectionIds: remainingEdges,
              selectedConnectionId:
                prev.selectedConnectionId !== null && deadEdges.has(prev.selectedConnectionId)
                  ? (remainingEdges.length > 0
                      ? remainingEdges[remainingEdges.length - 1]!
                      : null)
                  : prev.selectedConnectionId,
              editingNodeId:
                prev.editingNodeId !== null && doomedNodes.has(prev.editingNodeId)
                  ? null
                  : prev.editingNodeId,
            };
          });
        },

        renameDiagram: (name) => {
          const s = get();
          const diagram = active(s);
          commit('rename', (prev) => ({
            diagrams: { ...prev.diagrams, [diagram.id]: { ...diagram, name, updatedAt: Date.now() } },
          }));
        },

        clearDiagram: () => {
          const s = get();
          const diagram = active(s);
          commit('clear', (prev) => ({
            diagrams: {
              ...prev.diagrams,
              [diagram.id]: { ...diagram, nodes: [], connections: [], positions: {}, updatedAt: Date.now() },
            },
            selectedNodeId: null,
            selectedNodeIds: [],
            selectedConnectionId: null,
            selectedConnectionIds: [],
            editingNodeId: null,
          }));
        },

        replaceDiagram: (diagram) => {
          if (!isValidDiagram(diagram)) return;
          commit('replace', () => ({
            diagrams: { [diagram.id]: normalizeDiagram(diagram) },
            activeDiagramId: diagram.id,
            selectedNodeId: null,
            selectedNodeIds: [],
            selectedConnectionId: null,
            selectedConnectionIds: [],
            editingNodeId: null,
          }));
        },

        undo: () => {
          const s = get();
          if (s.past.length === 0) return;
          const prev = s.past[s.past.length - 1];
          lastEdit = { type: '', time: 0 };
          set({
            diagrams: prev.diagrams,
            activeDiagramId: prev.activeDiagramId,
            past: s.past.slice(0, -1),
            future: [{ diagrams: s.diagrams, activeDiagramId: s.activeDiagramId }, ...s.future].slice(
              0,
              HISTORY_LIMIT,
            ),
            selectedNodeId: null,
            selectedNodeIds: [],
            selectedConnectionId: null,
            selectedConnectionIds: [],
            editingNodeId: null,
          });
        },

        redo: () => {
          const s = get();
          if (s.future.length === 0) return;
          const [next, ...rest] = s.future;
          lastEdit = { type: '', time: 0 };
          set({
            diagrams: next.diagrams,
            activeDiagramId: next.activeDiagramId,
            past: [
              ...s.past.slice(-HISTORY_LIMIT + 1),
              { diagrams: s.diagrams, activeDiagramId: s.activeDiagramId },
            ],
            future: rest,
            selectedNodeId: null,
            selectedNodeIds: [],
            selectedConnectionId: null,
            selectedConnectionIds: [],
            editingNodeId: null,
          });
        },

        setSelection: (nodeId, connectionId) =>
          set({
            selectedNodeId: nodeId,
            selectedNodeIds: nodeId === null ? [] : [nodeId],
            selectedConnectionId: connectionId,
            selectedConnectionIds: connectionId === null ? [] : [connectionId],
          }),

        setCanvasSelection: (nodeIds, connectionIds) => {
          const dedupe = (ids: string[]): string[] => {
            const seen = new Set<string>();
            const next: string[] = [];
            for (const id of ids) {
              if (!seen.has(id)) {
                seen.add(id);
                next.push(id);
              }
            }
            return next;
          };
          const nextNodes = dedupe(nodeIds);
          const nextEdges = dedupe(connectionIds);
          set({
            selectedNodeIds: nextNodes,
            selectedNodeId: nextNodes.length > 0 ? nextNodes[nextNodes.length - 1]! : null,
            selectedConnectionIds: nextEdges,
            selectedConnectionId: nextEdges.length > 0 ? nextEdges[nextEdges.length - 1]! : null,
          });
        },

        setActiveTool: (tool) => set({ activeTool: tool }),

        setEditingNode: (nodeId, field = 'label') =>
          set({ editingNodeId: nodeId, editingField: field }),
      };
    },
    {
      name: 'sanklean:v1',
      version: 1,
      partialize: (s) => ({ diagrams: s.diagrams, activeDiagramId: s.activeDiagramId }),
      migrate: (persisted) => {
        // Fill in fields added after the first release (value, color).
        const state = persisted as { diagrams?: Record<string, Diagram>; activeDiagramId?: string };
        if (!state || typeof state !== 'object' || !state.diagrams) return persisted as never;
        const diagrams = Object.fromEntries(
          Object.entries(state.diagrams).map(([id, d]) => [id, isValidDiagram(d) ? normalizeDiagram(d) : d]),
        );
        return { ...state, diagrams } as never;
      },
      // One-time carry-over from the pre-rename key so existing diagrams survive.
      // New installs read/write `sanklean:v1` only; old installs get copied once.
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            const current = localStorage.getItem(key);
            if (current !== null) return current;
            if (key === 'sanklean:v1') return localStorage.getItem('flowtrack:v1');
            return null;
          } catch {
            return null;
          }
        },
        setItem: (key, value) => {
          try {
            localStorage.setItem(key, value);
          } catch {
            // Private mode etc. — diagram just won't persist this session.
          }
        },
        removeItem: (key) => {
          try {
            localStorage.removeItem(key);
          } catch {
            // Ignore storage errors during cleanup.
          }
        },
      })),
    },
  ),
);

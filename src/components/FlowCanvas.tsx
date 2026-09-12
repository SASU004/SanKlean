import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  SelectionMode,
  useInternalNode,
  useReactFlow,
  useStore as useFlowStore,
  useViewport,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toReactFlowEdges, toReactFlowNodes } from '../adapters/reactflow';
import { useEffectiveTheme } from '../state/appearanceStore';
import { useDiagramStore } from '../state/diagramStore';
import FlowNode from './FlowNode';
import SankeyEdge from './SankeyEdge';
import OnboardingHint from './OnboardingHint';

const nodeTypes = { flowNode: FlowNode };
const edgeTypes = { sankey: SankeyEdge };

const TOOLBAR_GAP = 20;
const VIEWPORT_MARGIN = 8;
const FALLBACK_TOOLBAR_WIDTH = 264;
const FALLBACK_TOOLBAR_HEIGHT = 36;

/**
 * Viewport-aware selected-node menu (Rename | Value | + Child | Delete).
 *
 * Underlying cause of the old bug: the menu was anchored with a fixed
 * `position={Position.Bottom}` + `offset={20}`. React Flow converts the
 * node's canvas coordinates to screen coordinates correctly on pan/zoom,
 * but a fixed Bottom anchor can never stay in view: near the bottom edge
 * it clips outside the viewport, near the top/edges it can cover the
 * node's own label/value, and it never consults the menu's real size.
 *
 * This keeps the exact same buttons/design and instead positions an
 * unscaled overlay in screen space:
 * - flow -> screen via `flow * zoom + viewport` (correct under pan/zoom,
 *   no hard-coded viewport size, no stale coordinates),
 * - measured menu size via ResizeObserver (not fixed offsets),
 * - prefer below, else above (flipped when the label lives on that side),
 * - clamped left/right + top/bottom so it stays fully inside the viewport.
 * It re-renders on viewport change (pan/zoom), node moves (internal node
 * position), selection change, and resize — one unified implementation.
 */
function SelectedNodeToolbar() {
  const selectedNodeId = useDiagramStore((s) => s.selectedNodeId);
  const selectedNodeIds = useDiagramStore((s) => s.selectedNodeIds);
  const setEditingNode = useDiagramStore((s) => s.setEditingNode);
  const addChild = useDiagramStore((s) => s.addChild);
  const removeNode = useDiagramStore((s) => s.removeNode);
  const internalNode = useInternalNode(selectedNodeId ?? '');
  const viewport = useViewport();
  const rfWidth = useFlowStore((s) => s.width);
  const rfHeight = useFlowStore((s) => s.height);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState<{ w: number; h: number } | null>(null);

  const isVisible =
    selectedNodeIds.length === 1 && selectedNodeId !== null && internalNode !== null && internalNode !== undefined;

  useLayoutEffect(() => {
    if (!isVisible) return;
    const el = toolbarRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setToolbarSize((prev) => {
        if (prev && Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5) return prev;
        return { w: rect.width, h: rect.height };
      });
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [isVisible, selectedNodeId]);

  const placement = useMemo(() => {
    if (!internalNode) return null;
    const nodeX = internalNode.internals.positionAbsolute.x;
    const nodeY = internalNode.internals.positionAbsolute.y;
    const nodeW = internalNode.measured?.width ?? 12;
    const rawBarHeight: unknown = (internalNode.data as { barHeight?: unknown }).barHeight;
    const nodeH =
      internalNode.measured?.height ??
      (typeof rawBarHeight === 'number' && Number.isFinite(rawBarHeight)
        ? Math.min(260, Math.max(52, Math.round(rawBarHeight)))
        : 52);
    const labelSide: unknown = (internalNode.data as { labelSide?: unknown }).labelSide;

    const toolbarW = toolbarSize?.w ?? FALLBACK_TOOLBAR_WIDTH;
    const toolbarH = toolbarSize?.h ?? FALLBACK_TOOLBAR_HEIGHT;

    const nodeScreenX = nodeX * viewport.zoom + viewport.x;
    const nodeScreenY = nodeY * viewport.zoom + viewport.y;
    const nodeScreenW = nodeW * viewport.zoom;
    const nodeScreenH = nodeH * viewport.zoom;

    const hasViewport =
      typeof rfWidth === 'number' && typeof rfHeight === 'number' && rfWidth > 0 && rfHeight > 0;
    const vpW = hasViewport ? rfWidth : 0;
    const vpH = hasViewport ? rfHeight : 0;

    const idealX = nodeScreenX + nodeScreenW / 2 - toolbarW / 2;
    const clampX = (x: number): number => {
      if (!hasViewport) return x;
      return Math.min(Math.max(x, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vpW - toolbarW - VIEWPORT_MARGIN));
    };
    const clampY = (y: number): number => {
      if (!hasViewport) return y;
      return Math.min(Math.max(y, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vpH - toolbarH - VIEWPORT_MARGIN));
    };

    const yBelow = nodeScreenY + nodeScreenH + TOOLBAR_GAP;
    const yAbove = nodeScreenY - TOOLBAR_GAP - toolbarH;

    let placeAbove: boolean;
    if (!hasViewport) {
      placeAbove = labelSide === 'bottom';
    } else {
      const spaceBelow = vpH - (nodeScreenY + nodeScreenH + TOOLBAR_GAP) - VIEWPORT_MARGIN;
      const spaceAbove = nodeScreenY - TOOLBAR_GAP - VIEWPORT_MARGIN;
      const fitsBelow = spaceBelow >= toolbarH;
      const fitsAbove = spaceAbove >= toolbarH;
      if (labelSide === 'bottom') {
        if (fitsAbove) placeAbove = true;
        else if (fitsBelow) placeAbove = false;
        else placeAbove = spaceAbove > spaceBelow;
      } else if (labelSide === 'top') {
        if (fitsBelow) placeAbove = false;
        else if (fitsAbove) placeAbove = true;
        else placeAbove = spaceAbove > spaceBelow;
      } else if (fitsBelow) {
        placeAbove = false;
      } else if (fitsAbove) {
        placeAbove = true;
      } else {
        placeAbove = spaceAbove > spaceBelow;
      }
    }

    return { left: clampX(idealX), top: clampY(placeAbove ? yAbove : yBelow) };
  }, [internalNode, viewport, rfWidth, rfHeight, toolbarSize]);

  if (!isVisible || !internalNode || !placement || selectedNodeId === null) return null;

  return (
    <div
      ref={toolbarRef}
      className="node-toolbar nodrag nopan"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: placement.left, top: placement.top, zIndex: 10 }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          setEditingNode(selectedNodeId, 'label');
        }}
        title="Edit name"
      >
        Rename
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setEditingNode(selectedNodeId, 'value');
        }}
        title="Edit value"
      >
        Value
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          addChild(selectedNodeId);
        }}
        title="Create a connected child node"
      >
        + Child
      </button>
      <button
        className="danger"
        onClick={(e) => {
          e.stopPropagation();
          removeNode(selectedNodeId);
        }}
        title="Delete node and its connections (Del)"
      >
        Delete
      </button>
    </div>
  );
}

function CanvasInner() {
  const diagram = useDiagramStore((s) => s.activeDiagram());
  const addNode = useDiagramStore((s) => s.addNode);
  const moveNode = useDiagramStore((s) => s.moveNode);
  const addConnection = useDiagramStore((s) => s.addConnection);
  const removeNodes = useDiagramStore((s) => s.removeNodes);
  const removeConnections = useDiagramStore((s) => s.removeConnections);
  const deleteSelected = useDiagramStore((s) => s.deleteSelected);
  const setSelection = useDiagramStore((s) => s.setSelection);
  const setCanvasSelection = useDiagramStore((s) => s.setCanvasSelection);
  const setActiveTool = useDiagramStore((s) => s.setActiveTool);
  const isSelect = useDiagramStore((s) => s.activeTool === 'select');
  const isDark = useEffectiveTheme() === 'dark';
  const selectedNodeIds = useDiagramStore((s) => s.selectedNodeIds);
  const selectedConnectionIds = useDiagramStore((s) => s.selectedConnectionIds);
  const undo = useDiagramStore((s) => s.undo);
  const redo = useDiagramStore((s) => s.redo);
  const { screenToFlowPosition } = useReactFlow();
  // Hand is the primary/default tool: empty-canvas drag pans (infinite
  // whiteboard), while nodes/ribbons stay fully interactable — hover makes
  // them selectable, click selects, node drag moves (ribbons follow
  // automatically), Shift-click and Shift-drag marquee multi-select.
  // Selector is secondary, for group deletion only: empty-canvas drag draws
  // a marquee rectangle instead of panning (click selects, Shift-click
  // toggles, empty click clears — all via the shared selection snapshot).
  // Marquee-gesture tracking so Escape truly cancels an in-progress
  // selection rectangle: while `cancelMarquee` is set, the trailing
  // selection snapshot from that gesture is dropped instead of re-selecting
  // on release.
  const marqueeActiveRef = useRef(false);
  const cancelMarqueeRef = useRef(false);

  const nodes = useMemo(
    () => toReactFlowNodes(diagram, selectedNodeIds),
    [diagram, selectedNodeIds],
  );
  const edges = useMemo(
    () => toReactFlowEdges(diagram, selectedConnectionIds),
    [diagram, selectedConnectionIds],
  );
  const isEmpty = diagram.nodes.length === 0;

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Selection is synced via onSelectionChange below; here we only apply
      // position drags (node moves) and batched removes.
      const removeIds: string[] = [];
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position) {
          // Applied both while dragging (flows follow the cursor) and on
          // drag end (final position persisted via the autosave store).
          // Multi-drag sends one change per dragged node; bursts coalesce
          // into a single history entry in the store.
          moveNode(ch.id, ch.position);
        } else if (ch.type === 'remove') {
          removeIds.push(ch.id);
        }
      }
      // Batch deletes remove all nodes + their attached connections in ONE
      // undo step. (Keyboard Delete is handled by our own key handler via
      // deleteSelected so mixed node+ribbon deletes stay in one step; this
      // path is a safety net.)
      if (removeIds.length > 0) removeNodes(removeIds);
    },
    [moveNode, removeNodes],
  );

  const onSelectionStart = useCallback(() => {
    // Fresh marquee gesture: it is active and not cancelled.
    marqueeActiveRef.current = true;
    cancelMarqueeRef.current = false;
  }, []);

  const onSelectionEnd = useCallback(() => {
    marqueeActiveRef.current = false;
    cancelMarqueeRef.current = false;
  }, []);

  const onSelectionChange = useCallback(
    (params: { nodes: { id: string }[]; edges: { id: string }[] }) => {
      // A cancelled marquee (Escape mid-drag) contributes no selections.
      if (cancelMarqueeRef.current && marqueeActiveRef.current) return;
      setCanvasSelection(
        params.nodes.map((n) => n.id),
        params.edges.map((e) => e.id),
      );
    },
    [setCanvasSelection],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Selection is synced via onSelectionChange; here we only apply
      // batched removes in ONE undo step.
      const removeIds: string[] = [];
      for (const ch of changes) {
        if (ch.type === 'remove') removeIds.push(ch.id);
      }
      if (removeIds.length > 0) removeConnections(removeIds);
    },
    [removeConnections],
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      // Clicking empty canvas deselects (Shift-click preserves for multi-select).
      if (!event.shiftKey) setSelection(null, null);
    },
    [setSelection],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (conn.source && conn.target) addConnection(conn.source, conn.target, 1);
    },
    [addConnection],
  );

  // Connect-on-drop onto empty canvas: dragging a handle to empty space creates a node.
  // Client-point extraction covers MouseEvent, PointerEvent (touch/pen carry
  // clientX/Y directly), and TouchEvent (coordinates live on touches or
  // changedTouches — Safari fires the latter on touchend). Without this,
  // touch connect-on-drop lands at the origin on some browsers.
  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      state: { isValid: boolean | null; fromNode?: { id: string } | null },
    ) => {
      if (state.isValid) return;
      if (!state.fromNode) return;
      const target = event.target as Element | null;
      if (target?.closest?.('.react-flow__node')) return;
      const withTouch = event as Partial<MouseEvent> & {
        touches?: ArrayLike<{ clientX: number; clientY: number }>;
        changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
      };
      const touchPoint = withTouch.touches?.[0] ?? withTouch.changedTouches?.[0];
      const clientX = touchPoint?.clientX ?? withTouch.clientX ?? 0;
      const clientY = touchPoint?.clientY ?? withTouch.clientY ?? 0;
      const position = screenToFlowPosition({ x: clientX, y: clientY });
      const newId = addNode(undefined, position);
      addConnection(state.fromNode.id, newId, 1);
    },
    [addConnection, addNode, screenToFlowPosition],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.react-flow__node') || target.closest('.react-flow__edge')) return;
      addNode(undefined, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addNode, screenToFlowPosition],
  );

  // Whiteboard shortcuts. Skipped inside text inputs so the browser's own
  // text undo and the inline editors keep working; editors additionally
  // stopPropagation on their keys, so Escape cancels an edit instead of
  // clearing the selection. Delete/Backspace never fires while editing a
  // node name or numeric value (INPUT/TEXTAREA guard preserves caret behavior).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if (el.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape') {
        // Clears the selection and cancels any in-progress marquee (its
        // trailing snapshot is dropped above). Diagram untouched.
        if (marqueeActiveRef.current) cancelMarqueeRef.current = true;
        setSelection(null, null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete the selected node(s)/ribbon(s). Nodes drop their attached
        // connections; ribbons drop only themselves. No-op when empty.
        e.preventDefault();
        deleteSelected();
        return;
      }
      // Tool shortcut. The INPUT/TEXTAREA guard above keeps typed H/N
      // inside node name/value editors as plain text. Hand is the default
      // (including after refresh); H returns to it. Selector has no
      // shortcut — it is activated explicitly from the toolbar.
      if (e.key === 'h' || e.key === 'H') {
        setActiveTool('hand');
        return;
      }
      if (e.key === 'n' || e.key === 'N') addNode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addNode, setSelection, setActiveTool, deleteSelected, undo, redo]);

  return (
    <div className={`canvas-wrap ${isSelect ? 'tool-select' : 'tool-hand'}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onDoubleClick={onDoubleClick}
        onPaneClick={onPaneClick}
        onSelectionStart={onSelectionStart}
        onSelectionEnd={onSelectionEnd}
        onSelectionChange={onSelectionChange}
        deleteKeyCode={null}
        // Hand: empty-canvas drag pans (React Flow only marquees on
        // Shift-drag when panOnDrag is true). Selector: empty-canvas drag
        // marquees (panOnDrag off), Shift-click toggles, empty click clears.
        panOnDrag={isSelect ? false : true}
        selectionOnDrag={true}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode="Shift"
        nodesDraggable={true}
        nodesConnectable={true}
        elementsSelectable={true}
        nodesFocusable={true}
        edgesFocusable={true}
        fitView={diagram.nodes.length > 0}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color={isDark ? '#475569' : '#cbd5e1'} />
        <Controls showInteractive={false} />
        <SelectedNodeToolbar />
      </ReactFlow>
      {isEmpty && <OnboardingHint />}
    </div>
  );
}

export default function FlowCanvas() {
  return <CanvasInner />;
}

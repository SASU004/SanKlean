import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  NodeToolbar,
  Position,
  ReactFlow,
  SelectionMode,
  useReactFlow,
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

function CanvasInner() {
  const diagram = useDiagramStore((s) => s.activeDiagram());
  const addNode = useDiagramStore((s) => s.addNode);
  const addChild = useDiagramStore((s) => s.addChild);
  const moveNode = useDiagramStore((s) => s.moveNode);
  const addConnection = useDiagramStore((s) => s.addConnection);
  const removeNode = useDiagramStore((s) => s.removeNode);
  const removeNodes = useDiagramStore((s) => s.removeNodes);
  const removeConnections = useDiagramStore((s) => s.removeConnections);
  const deleteSelected = useDiagramStore((s) => s.deleteSelected);
  const setSelection = useDiagramStore((s) => s.setSelection);
  const setCanvasSelection = useDiagramStore((s) => s.setCanvasSelection);
  const setActiveTool = useDiagramStore((s) => s.setActiveTool);
  const isSelect = useDiagramStore((s) => s.activeTool === 'select');
  const isDark = useEffectiveTheme() === 'dark';
  const setEditingNode = useDiagramStore((s) => s.setEditingNode);
  const selectedNodeId = useDiagramStore((s) => s.selectedNodeId);
  const selectedNodeIds = useDiagramStore((s) => s.selectedNodeIds);
  const selectedConnectionIds = useDiagramStore((s) => s.selectedConnectionIds);
  const undo = useDiagramStore((s) => s.undo);
  const redo = useDiagramStore((s) => s.redo);
  const { screenToFlowPosition } = useReactFlow();
  // Hand is the primary/default tool: empty-canvas drag pans (infinite
  // whiteboard), while nodes/ribbons stay fully interactable — hover makes
  // them selectable, click selects, node drag moves, ribbon control-point
  // drag reshapes, Shift-click and Shift-drag marquee multi-select.
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
        <NodeToolbar
          nodeId={selectedNodeId ?? undefined}
          isVisible={selectedNodeIds.length === 1 && selectedNodeId !== null}
          position={Position.Bottom}
          offset={20}
        >
          <div
            className="node-toolbar nodrag nopan"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (selectedNodeId) setEditingNode(selectedNodeId, 'label');
              }}
              title="Edit name"
            >
              Rename
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (selectedNodeId) setEditingNode(selectedNodeId, 'value');
              }}
              title="Edit value"
            >
              Value
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (selectedNodeId) addChild(selectedNodeId);
              }}
              title="Create a connected child node"
            >
              + Child
            </button>
            <button
              className="danger"
              onClick={(e) => {
                e.stopPropagation();
                if (selectedNodeId) removeNode(selectedNodeId);
              }}
              title="Delete node and its connections (Del)"
            >
              Delete
            </button>
          </div>
        </NodeToolbar>
      </ReactFlow>
      {isEmpty && <OnboardingHint />}
    </div>
  );
}

export default function FlowCanvas() {
  return <CanvasInner />;
}

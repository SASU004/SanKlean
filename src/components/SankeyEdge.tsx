import { useCallback, useMemo, useRef, useState } from 'react';
import { EdgeToolbar, type EdgeProps } from '@xyflow/react';
import { edgeThickness, type RFEdge } from '../adapters/reactflow';
import { parseBoundedIntInput } from '../domain/numbers';
import { buildFlowRibbon } from './sankeyGeometry';
import { useDiagramStore } from '../state/diagramStore';

const DEFAULT_COLOR = '#6366f1';

/**
 * Sankey flow edge: a filled ribbon with flat vertical ends along smooth
 * cubic-bezier boundaries — no arrowheads, no thin arrows, no centerline.
 *
 * - Width comes from the diagram-wide flow layout (the EFFECTIVE flow:
 *   the child node's value for ordinary one-parent flows, the stored
 *   edge value only for multi-parent targets).
 * - One-parent flows show their derived value read-only — the child owns
 *   the number, so there is no second editable copy on the edge.
 * - Lane offsets from the adapter stack sibling flows edge-to-edge so
 *   they never fully overlap; color is inherited from the source node
 *   (deterministic across reloads) at a moderate opacity so overlaps stay
 *   readable while node bars remain visually stronger.
 * - Selected edges render slightly stronger with a clearer outline.
 * - Curves are always automatic: moving either endpoint node re-anchors
 *   the ribbon and the Sankey curvature is re-derived. There are no
 *   manual handles by design (V1 stays Sankey-focused).
 */
export default function SankeyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  selected,
}: EdgeProps<RFEdge>) {
  const removeConnection = useDiagramStore((s) => s.removeConnection);
  const updateConnection = useDiagramStore((s) => s.updateConnection);

  const value = data?.value ?? 1;
  // One-parent flows are derived from the child value: displayed read-only,
  // never edited here. Multi-parent flows keep the stored editable value.
  const derived = data?.derived === true;
  // Rendered width from the diagram-wide layout (proportional to value,
  // uniformly fitted to the canvas). Falls back to the absolute scale.
  const width = typeof data?.width === 'number' && Number.isFinite(data.width) ? data.width : edgeThickness(value);
  const color = data?.color ?? DEFAULT_COLOR;

  const anchorS = { x: sourceX, y: sourceY + (data?.sourceDy ?? 0) };
  const anchorT = { x: targetX, y: targetY + (data?.targetDy ?? 0) };

  const flow = useMemo(
    () => buildFlowRibbon(anchorS, anchorT, width),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchorS.x, anchorS.y, anchorT.x, anchorT.y, width],
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Same blur-after-Escape guard as the node editors.
  const editingRef = useRef(false);
  // Stable ref: selects the initial draft ONCE on mount, never per
  // keystroke (an inline ref callback would re-select all text on every
  // render, breaking multi-digit entry like "40" or "10000").
  const selectOnceRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const closeEditor = () => {
    editingRef.current = false;
    setEditing(false);
  };

  const commit = () => {
    if (!editingRef.current) return;
    // Full multi-digit support, 0..10000 int. Unparseable keeps old value.
    const parsed = parseBoundedIntInput(draft);
    if (parsed !== null && parsed !== value) {
      updateConnection(id, { value: parsed });
    }
    closeEditor();
  };

  const cancel = () => {
    if (!editingRef.current) return;
    closeEditor();
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  };

  return (
    <>
      {/* Wide invisible centerline hit-area so thin flows stay clickable */}
      <path
        d={flow.center}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(24, width + 10)}
        style={{ pointerEvents: 'stroke' }}
      />
      {/* Visible flow ribbon — closed filled Sankey band with flat vertical
          ends flush against the node bars. No arrowhead, no rounded caps.
          The thin same-color stroke only seals the fill boundary; it never
          reads as a separate line and never creates thickness. */}
      <path
        d={flow.path}
        fill={color}
        fillOpacity={selected ? 0.92 : 0.65}
        stroke={color}
        strokeWidth={selected ? 2 : 1}
        strokeLinejoin="miter"
        strokeLinecap="butt"
      />
      <EdgeToolbar edgeId={id} x={flow.labelX} y={flow.labelY} isVisible={selected === true}>
        <div
          className="edge-toolbar nodrag nopan"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {derived ? (
            <span
              className="edge-value"
              style={{ cursor: 'default' }}
              title="Flow equals the child node value"
            >
              {value}
            </span>
          ) : editing ? (
            <input
              className="edge-value-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              placeholder="0"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditorKeyDown}
              onBlur={commit}
              ref={selectOnceRef}
              aria-label="Connection value (0 to 10000)"
            />
          ) : (
            <button
              className="edge-value"
              onClick={(e) => {
                e.stopPropagation();
                setDraft(String(value));
                editingRef.current = true;
                setEditing(true);
              }}
              title="Click to edit flow value"
            >
              {value}
            </button>
          )}
          <button
            className="edge-delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              removeConnection(id);
            }}
            title="Delete connection (Del)"
            aria-label="Delete connection"
          >
            ×
          </button>
        </div>
      </EdgeToolbar>
    </>
  );
}

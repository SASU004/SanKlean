import { useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { RFNode } from '../adapters/reactflow';
import { parseBoundedIntInput } from '../domain/numbers';
import { useDiagramStore, type EditField } from '../state/diagramStore';

const DEFAULT_COLOR = '#6366f1';

type Editing = 'label' | 'value' | null;

/**
 * Sankey node: a narrow vertical bar (the node itself) with its
 * name + value floating beside it — no cards, no shadows, no warnings.
 *
 * - The bar carries the node's auto-assigned color and is what flows
 *   visually connect to (handles sit on the bar's edges).
 * - Name/value render as ONE block outside the bar and outside all
 *   ribbons. The side (`data.labelSide`) is resolved deterministically
 *   from node positions + ribbon geometry: sources prefer LEFT,
 *   downstream prefer RIGHT, falling back to ABOVE/BELOW on collision.
 *   It recomputes on every render, so dragging a node re-places its label.
 * - Name/value remain directly editable in place: click the value, or
 *   double-click / click-when-selected the name. Enter commits, Escape
 *   cancels, blur commits. Drafts live in local state so typing full
 *   multi-digit numbers ("31", "1000", "10000") never round-trips
 *   through the store mid-keystroke.
 * - Node value is fully independent from flow values: editing here never
 *   touches connections, and missing/out-of-balance flows are valid.
 * - Handles are invisible at rest (opacity 0) and appear on hover /
 *   selection / active connecting so the resting state reads as a
 *   Sankey visualization, not a node editor.
 */
export default function FlowNode({ data, selected }: NodeProps<RFNode>) {
  const id = data.domainId;
  const updateNode = useDiagramStore((s) => s.updateNode);
  const setSelection = useDiagramStore((s) => s.setSelection);
  const setEditingNode = useDiagramStore((s) => s.setEditingNode);
  const editRequest = useDiagramStore((s): EditField | null =>
    s.editingNodeId === id ? s.editingField : null,
  );

  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState('');
  // Tracks the live editing session. Blur fires after Escape unmounts the
  // input, so the blur handler must consult this ref (not stale state)
  // to avoid committing a cancelled edit.
  const editingRef = useRef<Editing>(null);

  // Stable ref: selects the initial draft ONCE when the input mounts
  // (edit session begins), then never again. An inline `ref={(el) => ...}`
  // would create a new callback every render, making React detach/attach
  // it on each keystroke and re-select all text — so typing "4" then "0"
  // would replace "4" instead of producing "40". Stable identity keeps
  // normal browser caret behavior after the first character.
  const selectOnceRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const openEditor = (kind: Exclude<Editing, null>, initialDraft: string) => {
    editingRef.current = kind;
    setDraft(initialDraft);
    setEditing(kind);
  };

  const closeEditor = () => {
    editingRef.current = null;
    setEditing(null);
    if (useDiagramStore.getState().editingNodeId === id) setEditingNode(null);
  };

  // Newly created nodes (via + Add node / + Add child / double-click /
  // connect-on-drop) — and the contextual toolbar — request an inline
  // editor through the store, naming the exact field to focus.
  useEffect(() => {
    if (editRequest && editingRef.current === null) {
      openEditor(editRequest, editRequest === 'label' ? data.label : String(data.value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest]);

  const finish = (commit: boolean) => {
    if (editingRef.current === null) return;
    if (editing === 'label' && commit) {
      const next = draft.trim();
      if (next.length > 0 && next !== data.label) updateNode(id, { label: next });
    } else if (editing === 'value' && commit) {
      // Full multi-digit support: parse the whole draft ("31" -> 31),
      // clamp 0..10000 int. Unparseable drafts keep the old value.
      const parsed = parseBoundedIntInput(draft);
      if (parsed !== null && parsed !== data.value) updateNode(id, { value: parsed });
    }
    closeEditor();
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Keep React Flow / global shortcuts out of the editing session.
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };

  const startLabelEdit = () => {
    openEditor('label', data.label);
    setEditingNode(id, 'label');
  };

  const startValueEdit = () => {
    openEditor('value', String(data.value));
    setEditingNode(id, 'value');
  };

  const color = data.color || DEFAULT_COLOR;
  // Bar height comes from the diagram-wide flow layout: it grows to fit
  // this node's stacked flows so every band lands on the visible bar.
  // Isolated nodes rest at the minimum height.
  const barHeight =
    typeof data.barHeight === 'number' && Number.isFinite(data.barHeight)
      ? Math.min(260, Math.max(52, Math.round(data.barHeight)))
      : 52;
  // Label-block side resolved by the adapter from positions + ribbons.
  // Validated here so a stale/missing value can never strand text on a ribbon.
  const labelSide =
    data.labelSide === 'left' ||
    data.labelSide === 'right' ||
    data.labelSide === 'top' ||
    data.labelSide === 'bottom'
      ? data.labelSide
      : 'right';

  return (
    <div className={`sankey-node${selected ? ' selected' : ''}`} style={{ width: 12, height: barHeight }}>
      <Handle type="target" position={Position.Left} className="sankey-handle sankey-target" />
      <div className="sankey-bar" style={{ backgroundColor: color, width: 12, height: barHeight }} />

      <div className={`sankey-text side-${labelSide}`}>
        {editing === 'label' ? (
          <input
            className="sankey-input sankey-label-input nodrag"
            value={draft}
            spellCheck={false}
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEditorKeyDown}
            onBlur={() => finish(true)}
            ref={selectOnceRef}
            aria-label="Node name"
          />
        ) : (
          <div
            className="sankey-label"
            title={selected ? 'Click to rename' : 'Double-click to rename'}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startLabelEdit();
            }}
            onClick={(e) => {
              // Single click edits only when already selected, so the first
              // click still selects and drag-from-label still drags the node.
              if (selected) {
                e.stopPropagation();
                startLabelEdit();
              }
            }}
          >
            {data.label || 'Untitled'}
          </div>
        )}

        {editing === 'value' ? (
          <input
            className="sankey-input sankey-value-input nodrag"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder="0"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEditorKeyDown}
            onBlur={() => finish(true)}
            ref={selectOnceRef}
            aria-label="Node value (0 to 10000)"
          />
        ) : (
          <div
            className="sankey-value"
            title="Click to edit value"
            onClick={(e) => {
              e.stopPropagation();
              setSelection(id, null);
              startValueEdit();
            }}
          >
            {data.value}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="sankey-handle sankey-source" />
    </div>
  );
}

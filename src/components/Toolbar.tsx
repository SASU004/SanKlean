import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppearanceStore, type FontChoice, type ThemeChoice } from '../state/appearanceStore';
import { useDiagramStore } from '../state/diagramStore';

/** Deliberately minimal chrome: brand + diagram name + tool + the Add node action. */
type ClearPhase = 'idle' | 'waiting' | 'ready';
const CLEAR_COUNTDOWN_SECONDS = 3;

export default function Toolbar() {
  const name = useDiagramStore((s) => s.activeDiagram().name);
  const addNode = useDiagramStore((s) => s.addNode);
  const renameDiagram = useDiagramStore((s) => s.renameDiagram);
  const activeTool = useDiagramStore((s) => s.activeTool);
  const setActiveTool = useDiagramStore((s) => s.setActiveTool);
  const theme = useAppearanceStore((s) => s.theme);
  const font = useAppearanceStore((s) => s.font);
  const setTheme = useAppearanceStore((s) => s.setTheme);
  const setFont = useAppearanceStore((s) => s.setFont);
  const clearDiagram = useDiagramStore((s) => s.clearDiagram);
  const deleteSelected = useDiagramStore((s) => s.deleteSelected);
  const selectedNodeIds = useDiagramStore((s) => s.selectedNodeIds);
  const selectedConnectionIds = useDiagramStore((s) => s.selectedConnectionIds);
  const selectedConnectionId = useDiagramStore((s) => s.selectedConnectionId);
  const isEmpty = useDiagramStore(
    (s) => s.activeDiagram().nodes.length === 0 && s.activeDiagram().connections.length === 0,
  );
  const hasSelection =
    selectedNodeIds.length > 0 || selectedConnectionIds.length > 0 || selectedConnectionId !== null;

  // Clear All is intentionally destructive with a mandatory reading/wait
  // period: the dialog opens with a disabled Wait countdown (3s) during
  // which nothing is deleted. Only after the countdown does the final
  // Clear All action arm — deletion happens solely on that click, never
  // automatically when the timer reaches zero.
  const [clearPhase, setClearPhase] = useState<ClearPhase>('idle');
  const [secondsLeft, setSecondsLeft] = useState(CLEAR_COUNTDOWN_SECONDS);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Real-timer bookkeeping: at most one timeout is ever pending. The
  // remaining count lives in a ref; state only mirrors it for display.
  const timeoutRef = useRef<number | null>(null);
  const remainingRef = useRef(CLEAR_COUNTDOWN_SECONDS);

  const stopTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const cancelClear = useCallback(() => {
    // Immediately stops the countdown and preserves everything.
    stopTimer();
    remainingRef.current = CLEAR_COUNTDOWN_SECONDS;
    setClearPhase('idle');
    setSecondsLeft(CLEAR_COUNTDOWN_SECONDS);
  }, [stopTimer]);

  const openClearConfirm = useCallback(() => {
    if (isEmpty) return;
    // Fresh countdown on every open; stop-then-setPhase keeps one timer max
    // (the waiting effect below owns the actual timeout chain).
    stopTimer();
    remainingRef.current = CLEAR_COUNTDOWN_SECONDS;
    setSecondsLeft(CLEAR_COUNTDOWN_SECONDS);
    setClearPhase('waiting');
  }, [isEmpty, stopTimer]);

  // Drives the Wait countdown while the dialog is in `waiting`. Cleanup
  // stops the pending tick, so cancelling/closing mid-countdown or
  // unmounting never fires a stray tick and never deletes anything.
  useEffect(() => {
    if (clearPhase !== 'waiting') return;
    let stopped = false;
    const tick = function step(): void {
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null;
        if (stopped) return;
        remainingRef.current -= 1;
        if (remainingRef.current <= 0) {
          // Reading period over: arm the final action. Nothing is deleted
          // here — the user must still click Clear All.
          remainingRef.current = 0;
          setSecondsLeft(0);
          setClearPhase('ready');
        } else {
          setSecondsLeft(remainingRef.current);
          step();
        }
      }, 1000);
    };
    tick();
    return () => {
      stopped = true;
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [clearPhase]);

  const confirmClear = useCallback(() => {
    // Deletion happens ONLY on this explicit click after the countdown.
    if (clearPhase !== 'ready') return;
    stopTimer();
    clearDiagram();
    remainingRef.current = CLEAR_COUNTDOWN_SECONDS;
    setSecondsLeft(CLEAR_COUNTDOWN_SECONDS);
    setClearPhase('idle');
  }, [clearPhase, clearDiagram, stopTimer]);

  // Drop any pending tick if the toolbar ever unmounts mid-countdown.
  // (No state writes here — just timer cleanup.)
  useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  // While the dialog is open: focus Cancel for keyboard users, and let
  // Escape close it (the canvas Escape handler may also clear selection —
  // both are cancel/neutral actions, the diagram itself is preserved).
  useEffect(() => {
    if (clearPhase === 'idle') return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelClear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearPhase, cancelClear]);

  return (
    <>
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          ≈
        </span>
        <span className="brand-name">Sanklean</span>
        <input
          className="diagram-name"
          value={name}
          onChange={(e) => renameDiagram(e.target.value)}
          aria-label="Diagram name"
          spellCheck={false}
        />
      </div>
      <div className="toolbar-tools" role="toolbar" aria-label="Canvas tools">
        <button
          className={`btn tool${activeTool === 'hand' ? ' active' : ''}`}
          onClick={() => setActiveTool('hand')}
          title="Hand (H): drag to pan the canvas"
          aria-pressed={activeTool === 'hand'}
        >
          <span aria-hidden>✥</span> Hand
        </button>
        <button
          className={`btn tool${activeTool === 'select' ? ' active' : ''}`}
          onClick={() => setActiveTool('select')}
          title="Select elements for group deletion: drag to select a group, Del deletes"
          aria-pressed={activeTool === 'select'}
        >
          <span aria-hidden>⬚</span> Select
        </button>
      </div>
      <div className="toolbar-appearance" role="group" aria-label="Appearance">
        <select
          className="select-compact"
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeChoice)}
          aria-label="Theme"
          title="Theme: light, dark, or follow the system"
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <select
          className="select-compact"
          value={font}
          onChange={(e) => setFont(e.target.value as FontChoice)}
          aria-label="Font"
          title="Interface and label font"
        >
          <option value="inter">Inter</option>
          <option value="geist">Geist</option>
          <option value="plex">IBM Plex Sans</option>
          <option value="mono">JetBrains Mono</option>
          <option value="system">System</option>
        </select>
      </div>
      <div className="toolbar-actions">
        <button
          className="btn danger-btn"
          onClick={() => deleteSelected()}
          disabled={!hasSelection}
          title={
            hasSelection
              ? 'Delete selected node(s)/ribbon(s) (Del)'
              : 'Select a node or ribbon to delete it'
          }
        >
          Delete
        </button>
        <button
          className="btn"
          onClick={openClearConfirm}
          disabled={isEmpty}
          title={isEmpty ? 'Diagram is already empty' : 'Clear all nodes and connections…'}
        >
          Clear all
        </button>
        <button className="btn primary" onClick={() => addNode()} title="Add a node (N)">
          + Add node
        </button>
      </div>
    </header>
    {clearPhase !== 'idle' && (
      <div
        className="confirm-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) cancelClear();
        }}
      >
        <div
          className="confirm-card"
          role="alertdialog"
          aria-modal="true"
          aria-label="Clear entire diagram"
        >
          <h3>Clear entire diagram?</h3>
          <p>Clearing everything from the current panel cannot be undone or retrieved.</p>
          <div className="confirm-actions">
            <button ref={cancelRef} className="btn" onClick={cancelClear}>
              Cancel
            </button>
            {clearPhase === 'waiting' ? (
              <button className="btn danger-btn" disabled aria-live="polite">
                Wait {secondsLeft}…
              </button>
            ) : (
              <button className="btn danger-btn" onClick={confirmClear}>
                Clear All
              </button>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}

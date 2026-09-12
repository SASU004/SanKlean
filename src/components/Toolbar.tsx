import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppearanceStore, type FontChoice, type ThemeChoice } from '../state/appearanceStore';
import { useDiagramStore } from '../state/diagramStore';
import ShareButton from './ShareButton';

/** Minimal top chrome (brand + diagram name) + floating Excalidraw-style tool dock. */
type ClearPhase = 'idle' | 'waiting' | 'ready';
const CLEAR_COUNTDOWN_SECONDS = 3;

const SELECT_HELP_TEXT = 'Select individual elements or groups of elements for sharing or deletion.';

const TOOLTIP_GAP = 8;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_FALLBACK_WIDTH = 190;
const TOOLTIP_FALLBACK_HEIGHT = 32;

/**
 * Help tooltip for the Select tool, portaled to document.body so no
 * toolbox ancestor (`.dock` / `.dock-panel` both clip overflow) can cut
 * it off. Positioned fixed from the "?" anchor rect: to the right when
 * it fits, otherwise flipped left, always clamped into the viewport.
 */
function SelectHelpTip({
  anchorRef,
  text,
}: {
  anchorRef: React.RefObject<HTMLSpanElement | null>;
  text: string;
}) {
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tip = tipRef.current;
      const tw = tip && tip.offsetWidth > 0 ? tip.offsetWidth : TOOLTIP_FALLBACK_WIDTH;
      const th = tip && tip.offsetHeight > 0 ? tip.offsetHeight : TOOLTIP_FALLBACK_HEIGHT;
      const anchorCy = r.top + r.height / 2;
      const fitsRight = r.right + TOOLTIP_GAP + tw <= vw - TOOLTIP_MARGIN;
      const left = fitsRight
        ? r.right + TOOLTIP_GAP
        : Math.max(TOOLTIP_MARGIN, r.left - TOOLTIP_GAP - tw);
      const top = Math.min(
        Math.max(anchorCy, TOOLTIP_MARGIN + th / 2),
        Math.max(TOOLTIP_MARGIN + th / 2, vh - TOOLTIP_MARGIN - th / 2),
      );
      setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchorRef, text]);

  return createPortal(
    <div
      ref={tipRef}
      id="select-tool-tip"
      role="tooltip"
      className="dock-help-tip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {text}
    </div>,
    document.body,
  );
}

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

  // Collapsible left dock. A dedicated tools icon is the toggle; the panel
  // stays open until the user explicitly toggles it again (never auto-closes).
  // On small screens the panel starts collapsed so the canvas — the primary
  // experience — is visible first; the same toggle opens it (44px target).
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return !window.matchMedia('(max-width: 640px)').matches;
      }
    } catch {
      // matchMedia unavailable — fall through to the desktop default.
    }
    return true;
  });

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

  // Select "?" help tooltip (portaled outside the toolbox so it is never
  // clipped). Open on hover or keyboard focus, closed on leave/blur/Escape.
  const [selectTipOpen, setSelectTipOpen] = useState(false);
  const selectHelpRef = useRef<HTMLSpanElement>(null);

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
      <header className="topbar">
        <div className="brand">
          <img
            className="brand-logo"
            src="/sk-logo.png"
            alt="SanKlean logo"
            width={28}
            height={28}
          />
          <span className="brand-name">SanKlean</span>
          <input
            className="diagram-name"
            value={name}
            onChange={(e) => renameDiagram(e.target.value)}
            aria-label="Diagram name"
            placeholder="Name your diagram…"
            maxLength={80}
            spellCheck={false}
          />
        </div>
        <ShareButton />
      </header>

      <div className={`dock${panelOpen ? ' open' : ''}`}>
        <button
          className="dock-toggle"
          onClick={() => setPanelOpen((o) => !o)}
          aria-expanded={panelOpen}
          aria-label={panelOpen ? 'Close tools panel' : 'Open tools panel'}
          title={panelOpen ? 'Close tools panel' : 'Open tools panel'}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="4" y1="21" x2="4" y2="14" />
            <line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" />
            <line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" />
            <line x1="9" y1="8" x2="15" y2="8" />
            <line x1="17" y1="16" x2="23" y2="16" />
          </svg>
        </button>
        {panelOpen && (
          <div className="dock-panel" role="toolbar" aria-label="Canvas tools">
            <div className="dock-group">
              <button
                className={`dock-btn${activeTool === 'hand' ? ' active' : ''}`}
                onClick={() => setActiveTool('hand')}
                title="Hand (H): drag to pan the canvas"
                aria-pressed={activeTool === 'hand'}
              >
                <span className="dock-ico" aria-hidden>
                  ✥
                </span>
                <span>Hand</span>
              </button>
              <div className="dock-row">
                <button
                  className={`dock-btn dock-row-btn${activeTool === 'select' ? ' active' : ''}`}
                  onClick={() => setActiveTool('select')}
                  title={SELECT_HELP_TEXT}
                  aria-pressed={activeTool === 'select'}
                >
                  <span className="dock-ico" aria-hidden>
                    ⬚
                  </span>
                  <span>Select</span>
                </button>
                <span
                  ref={selectHelpRef}
                  className="dock-help"
                  tabIndex={0}
                  role="note"
                  aria-label={SELECT_HELP_TEXT}
                  aria-describedby={selectTipOpen ? 'select-tool-tip' : undefined}
                  onMouseEnter={() => setSelectTipOpen(true)}
                  onMouseLeave={() => setSelectTipOpen(false)}
                  onFocus={() => setSelectTipOpen(true)}
                  onBlur={() => setSelectTipOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSelectTipOpen(false);
                  }}
                >
                  ?
                </span>
                {selectTipOpen && (
                  <SelectHelpTip anchorRef={selectHelpRef} text={SELECT_HELP_TEXT} />
                )}
              </div>
              <button
                className="dock-btn primary"
                onClick={() => addNode()}
                title="Add a node (N)"
              >
                <span className="dock-ico" aria-hidden>
                  +
                </span>
                <span>Add node</span>
              </button>
            </div>

            <div className="dock-sep" aria-hidden />

            <div className="dock-group">
              <button
                className="dock-btn danger"
                onClick={() => deleteSelected()}
                disabled={!hasSelection}
                title={
                  hasSelection
                    ? 'Delete selected node(s)/ribbon(s) (Del)'
                    : 'Select a node or ribbon to delete it'
                }
                aria-label="Delete selected elements"
              >
                <span className="dock-ico" aria-hidden>
                  −
                </span>
                <span>Delete</span>
              </button>
              <button
                className="dock-btn"
                onClick={openClearConfirm}
                disabled={isEmpty}
                title={isEmpty ? 'Diagram is already empty' : 'Clear all nodes and connections…'}
              >
                <span className="dock-ico" aria-hidden>
                  ✕
                </span>
                <span>Clear all</span>
              </button>
            </div>

            <div className="dock-sep" aria-hidden />

            <div className="dock-group">
              <label className="dock-field">
                <span className="dock-label">Theme</span>
                <select
                  className="dock-select"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as ThemeChoice)}
                  aria-label="Theme"
                  title="Theme: light, dark, or follow the system"
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="dock-field">
                <span className="dock-label">Font</span>
                <select
                  className="dock-select"
                  value={font}
                  onChange={(e) => setFont(e.target.value as FontChoice)}
                  aria-label="Font"
                  title="Interface and label font"
                >
                  <option value="inter" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
                    Inter
                  </option>
                  <option
                    value="grotesk"
                    style={{ fontFamily: "'Space Grotesk', 'Inter', system-ui, sans-serif" }}
                  >
                    Space Grotesk
                  </option>
                  <option
                    value="plex"
                    style={{ fontFamily: "'IBM Plex Sans', 'Inter', system-ui, sans-serif" }}
                  >
                    IBM Plex Sans
                  </option>
                  <option value="dm" style={{ fontFamily: "'DM Sans', 'Inter', system-ui, sans-serif" }}>
                    DM Sans
                  </option>
                  <option
                    value="mono"
                    style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
                  >
                    JetBrains Mono
                  </option>
                </select>
              </label>
            </div>
          </div>
        )}
      </div>

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

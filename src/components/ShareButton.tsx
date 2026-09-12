import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  buildShareUrl,
  clearShareHash,
  copyTextToClipboard,
  decodeSharedDiagram,
  extractSelectedSubdiagram,
  isShareHash,
} from '../share';
import type { Diagram } from '../domain/types';
import { useDiagramStore } from '../state/diagramStore';

type ToastKind = 'copied' | 'failed';

const MENU_GAP = 6;
const MENU_MARGIN = 8;
const MENU_FALLBACK_WIDTH = 220;
const MENU_FALLBACK_HEIGHT = 96;

/**
 * Share menu shown only while a canvas selection exists. Portaled to
 * document.body (the topbar clips overflow) and clamped into the viewport.
 */
function ShareMenu({
  anchorRef,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onPick: (scope: 'all' | 'selection') => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const menu = menuRef.current;
      const mw = menu && menu.offsetWidth > 0 ? menu.offsetWidth : MENU_FALLBACK_WIDTH;
      const mh = menu && menu.offsetHeight > 0 ? menu.offsetHeight : MENU_FALLBACK_HEIGHT;
      const left = Math.min(
        Math.max(r.right - mw, MENU_MARGIN),
        Math.max(MENU_MARGIN, vw - mw - MENU_MARGIN),
      );
      const below = r.bottom + MENU_GAP;
      const top =
        below + mh <= vh - MENU_MARGIN
          ? below
          : Math.max(MENU_MARGIN, r.top - MENU_GAP - mh);
      setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    firstItemRef.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        !menuRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Share options"
      className="share-menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <button
        ref={firstItemRef}
        role="menuitem"
        className="dock-btn"
        onClick={() => onPick('all')}
      >
        <span>Share entire diagram</span>
      </button>
      <button role="menuitem" className="dock-btn" onClick={() => onPick('selection')}>
        <span>Share selection</span>
      </button>
    </div>,
    document.body,
  );
}

/**
 * Minimal Share: copies a self-contained `#s…` URL for the active diagram
 * (or just the current selection when one exists). Startup consumes a share
 * hash once — direct load on empty storage, otherwise an overwrite confirm.
 * Failed/invalid links keep local data.
 */
export default function ShareButton() {
  const [toast, setToast] = useState<ToastKind | null>(null);
  const [pending, setPending] = useState<Diagram | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const handledHash = useRef(false);
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const selectedNodeIds = useDiagramStore((s) => s.selectedNodeIds);
  const selectedNodeId = useDiagramStore((s) => s.selectedNodeId);
  const selectedConnectionIds = useDiagramStore((s) => s.selectedConnectionIds);
  const selectedConnectionId = useDiagramStore((s) => s.selectedConnectionId);

  const hasSelection =
    selectedNodeIds.length > 0 ||
    selectedNodeId !== null ||
    selectedConnectionIds.length > 0 ||
    selectedConnectionId !== null;

  useEffect(() => {
    if (handledHash.current) return;
    handledHash.current = true;
    const hash = window.location.hash;
    if (!isShareHash(hash)) return;
    void (async () => {
      // Wait for localStorage rehydration first: the persisted diagrams
      // may not be in state yet when this mount effect runs.
      try {
        await useDiagramStore.persist.rehydrate();
      } catch {
        // Storage unreadable — treat local as empty below.
      }
      const shared = await decodeSharedDiagram(hash);
      clearShareHash();
      if (!shared) return;
      const { diagrams, replaceDiagram } = useDiagramStore.getState();
      const hasLocal = Object.values(diagrams).some(
        (d) => d.nodes.length > 0 || d.connections.length > 0,
      );
      if (hasLocal) setPending(shared);
      else replaceDiagram(shared);
    })();
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const flash = (kind: ToastKind) => {
    setToast(kind);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 2200);
  };

  const copyDiagram = (diagram: Diagram) => {
    void (async () => {
      try {
        await copyTextToClipboard(await buildShareUrl(diagram));
        flash('copied');
      } catch {
        flash('failed');
      }
    })();
  };

  const shareAll = () => {
    copyDiagram(useDiagramStore.getState().activeDiagram());
  };

  const shareSelection = () => {
    const state = useDiagramStore.getState();
    const sub = extractSelectedSubdiagram(
      state.activeDiagram(),
      [...state.selectedNodeIds, ...(state.selectedNodeId ? [state.selectedNodeId] : [])],
      [
        ...state.selectedConnectionIds,
        ...(state.selectedConnectionId ? [state.selectedConnectionId] : []),
      ],
    );
    // Stale selection (nothing matches the canvas): fall back to the whole diagram.
    copyDiagram(sub ?? state.activeDiagram());
  };

  const onShare = () => {
    if (!hasSelection) {
      shareAll();
      return;
    }
    setMenuOpen((o) => !o);
  };

  const onPick = (scope: 'all' | 'selection') => {
    setMenuOpen(false);
    if (scope === 'all') shareAll();
    else shareSelection();
  };

  const openPending = () => {
    const diagram = pending;
    setPending(null);
    if (diagram) useDiagramStore.getState().replaceDiagram(diagram);
  };

  return (
    <>
      <div className="topbar-actions">
        <button
          ref={shareBtnRef}
          className="btn share-btn"
          onClick={onShare}
          aria-expanded={hasSelection ? menuOpen : undefined}
          aria-haspopup={hasSelection ? 'menu' : undefined}
          title={
            hasSelection ? 'Share the entire diagram or just the selection' : 'Copy a shareable link to this diagram'
          }
          aria-label="Share diagram"
        >
          Share
        </button>
      </div>
      {menuOpen && hasSelection && (
        <ShareMenu anchorRef={shareBtnRef} onPick={onPick} onClose={() => setMenuOpen(false)} />
      )}
      {toast === 'copied' && (
        <div className="share-toast" role="status">
          Link copied
        </div>
      )}
      {toast === 'failed' && (
        <div className="share-toast" role="alert">
          Couldn&apos;t copy link
        </div>
      )}
      {pending !== null && (
        <div
          className="confirm-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPending(null);
          }}
        >
          <div
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-label="Open shared diagram"
          >
            <h3>Open shared diagram?</h3>
            <p>This will replace your current diagram.</p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={openPending}>
                Open
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

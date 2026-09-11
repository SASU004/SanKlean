import { useEffect, useState } from 'react';

const SEEN_KEY = 'sanklean:help-seen';
const LEGACY_SEEN_KEY = 'flowtrack:help-seen';

function wasSeen(): boolean {
  try {
    if (localStorage.getItem(SEEN_KEY) === '1') return true;
    // One-time read of the pre-rename key so existing users keep their choice.
    return localStorage.getItem(LEGACY_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

/** Small unobtrusive help overlay: shortcuts + gestures, dismissible. */
export default function HelpOverlay() {
  const [open, setOpen] = useState(() => !wasSeen());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const dismiss = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Private mode etc. — overlay just reappears next visit.
    }
    setOpen(false);
  };

  return (
    <>
      <button
        className="help-fab"
        onClick={() => (open ? dismiss() : setOpen(true))}
        title="Help & shortcuts"
        aria-label="Help and shortcuts"
      >
        ?
      </button>
      {open && (
        <div className="help-card" role="dialog" aria-label="Help and shortcuts">
          <button className="help-close" onClick={dismiss} title="Dismiss" aria-label="Dismiss help">
            ×
          </button>
          <h3>SanKlean</h3>
          <ul>
            <li>
              <kbd>N</kbd> or double-click — new node
            </li>
            <li>Hover a bar → drag handle to another bar (or empty space)</li>
            <li>Click a name or value beside a bar to edit it</li>
            <li>Drag a flow&apos;s white dots to reshape it</li>
            <li>
              <kbd>Del</kbd> delete · <kbd>Esc</kbd> deselect
            </li>
            <li>Select tool — drag to select a group, then <kbd>Del</kbd></li>
            <li>
              <kbd>Ctrl/⌘ Z</kbd> undo · <kbd>Ctrl/⌘ ⇧ Z</kbd> redo
            </li>
            <li>Drag background to pan · wheel to zoom</li>
          </ul>
        </div>
      )}
    </>
  );
}

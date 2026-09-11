import { Component, type ReactNode } from 'react';

/**
 * Top-level safety net: an unexpected render error shows a minimal
 * recovery screen instead of a blank page. "Reset local data" clears
 * ONLY SanKlean's own persisted keys (current + legacy pre-rename keys —
 * the legacy diagram key must go too, otherwise the storage fallback
 * would resurrect the same corrupt state) and reloads.
 */

const SAN_KLEAN_KEYS = [
  'sanklean:v1',
  'sanklean:appearance:v1',
  'sanklean:help-seen',
  'flowtrack:v1',
  'flowtrack:help-seen',
];

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  resetLocalData = () => {
    try {
      for (const key of SAN_KLEAN_KEYS) localStorage.removeItem(key);
    } catch {
      // Private mode etc. — reload anyway; defaults apply for the session.
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-fallback" role="alert">
          <h2>Something went wrong</h2>
          <p>SanKlean hit an unexpected error and couldn&apos;t show the canvas.</p>
          <button className="btn primary" onClick={this.resetLocalData}>
            Reset local data
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import FlowCanvas from './components/FlowCanvas';
import HelpOverlay from './components/HelpOverlay';
import Toolbar from './components/Toolbar';
import { useAppearanceStore, useEffectiveTheme } from './state/appearanceStore';

export default function App() {
  const effectiveTheme = useEffectiveTheme();
  const font = useAppearanceStore((s) => s.font);

  // Concrete theme + font live on <html> so plain CSS vars do the rest.
  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.font = font;
  }, [effectiveTheme, font]);

  return (
    <div className="app">
      <Toolbar />
      <ReactFlowProvider>
        <FlowCanvas />
      </ReactFlowProvider>
      <HelpOverlay />
      <Analytics />
      <SpeedInsights />
    </div>
  );
}

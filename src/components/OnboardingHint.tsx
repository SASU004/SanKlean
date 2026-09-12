import { useDiagramStore } from '../state/diagramStore';

export default function OnboardingHint() {
  const addNode = useDiagramStore((s) => s.addNode);

  return (
    <div className="onboarding">
      <h2>Start your first flow</h2>
      <p>A blank whiteboard. Nodes can be anything — stages, sources, teams.</p>
      <ol>
        <li>
          Click <strong>+ Add node</strong> or double-click the canvas.
        </li>
        <li>Hover a bar to reveal its handles, then drag bar → bar to connect.</li>
        <li>Click a name or value beside a bar to edit it in place.</li>
        <li>Select a flow to edit its value.</li>
      </ol>
      <div className="onboarding-actions">
        <button className="btn primary" onClick={() => addNode('Applications', { x: 200, y: 200 })}>
          Create first node
        </button>
      </div>
    </div>
  );
}

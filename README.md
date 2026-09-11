# Sanklean

> A cleaner alternative to creating Sankey diagrams rather than coding or using Excel.

Sanklean is an interactive Sankey whiteboard. You create nodes, give them values,
and connect them into flows directly on an infinite canvas — the ribbons size
themselves from your numbers. No chart code, no spreadsheet formulas.

## Features

- Infinite canvas with pan and zoom
- Hand-first interaction (Hand is the default tool)
- Direct node creation: toolbar button, `N` key, double-click, or drag a handle onto empty canvas
- In-place editing of node names and values
- Sankey ribbons sized by flow value, colored by source node
- Draggable ribbon curve points with reset-to-automatic
- One-parent flow model: a child's value drives its incoming flow
- Parent-capacity enforcement across multiple child flows
- Automatic label placement beside node bars
- Selector tool for marquee group/structure selection and group deletion
- Delete/Backspace removal (deleting a node removes its connections; never orphans)
- Clear All with a destructive warning and a 3-second reading countdown
- Undo/redo (`Ctrl/⌘ Z`, `Ctrl/⌘ ⇧ Z`, `Ctrl/⌘ Y`)
- Light / Dark / System theme (persisted, follows the OS on System)
- Font selection: Inter, Geist, IBM Plex Sans, JetBrains Mono, System (persisted, local stacks only)
- Local persistence — diagrams autosave to `localStorage`

## How to use

### Create a diagram

1. Click **+ Add node** (or press `N`, or double-click the canvas). The new node's name is focused so you can type immediately.
2. Set its name (`Enter` commits, `Esc` cancels) and click its value to set a number (0–10000, whole numbers).
3. Hover a node bar to reveal its handles, then drag handle → handle to connect two nodes, or handle → empty space to branch a new child node. A selected node also offers **+ Child** in its floating toolbar.
4. Set each child value by clicking the value beside its bar. A child with exactly one parent drives its own incoming flow — there is no second copy of the number on the ribbon.
5. Drag node bars to move them; ribbons and labels follow. Drag a ribbon's white dots to reshape its curve (reset with ↺ on the selected flow's toolbar).

### Canvas interaction

- **Hand** is the default tool: drag empty canvas to pan, scroll to zoom, click nodes/ribbons to select, drag bars to move them, drag handles to connect.
- Ribbon width reflects flow value; sibling flows fan out into lanes along the bar.
- `?` (bottom-right) shows the shortcut help; dismiss it and it stays dismissed.

### Selection and deletion

- **Hand** = normal diagram interaction (navigate, move, edit, connect).
- **Selector** = group/structure selection and deletion. Activate it in the toolbar, then drag over empty canvas to draw a selection rectangle covering nodes and ribbons. Click selects one element, `Shift`-click adds/removes individual elements, clicking empty canvas clears the selection.
- `Delete`/`Backspace` removes everything selected in one step: nodes take their attached connections with them; deleting a ribbon removes only that connection. Deletion never fires while you are typing in a name/value field.
- **Clear All** = delete the entire current diagram (see below). It is separate from Selector.

### Clear All

Clear All is destructive and cannot be retrieved. Clicking it opens a warning dialog
("Clearing everything from the current panel cannot be undone or retrieved.") with a
disabled **Wait 3… → 2… → 1…** button. Nothing is deleted during the countdown.
Only after the countdown does the final **Clear All** button appear — the diagram is
cleared only when you click it. `Cancel`, `Esc`, or clicking outside closes the dialog
unchanged. The button is disabled while the diagram is already empty.

## Sankey value model

All values are whole numbers from 0 to 10000. The supported model is one parent per child:

- Root nodes (no parents) hold their own independent values.
- A child with exactly one parent drives its incoming flow from its own value; the ribbon shows that number read-only.
- A parent's single-parent children may never total more than the parent's value — excess is clamped down through siblings and descendants in creation order.
- Unused parent capacity is allowed and stays silent; it is not rendered as a flow.
- A child with multiple parents falls back to per-connection stored values (allocation across parents is outside the V1 model).

Example:

```text
Applications = 400
Replied = 200
Rejected = 100

Applications → Replied  = 200
Applications → Rejected = 100   (100 capacity left unused, no warning)
```

## Installation

Prerequisite: Node.js (npm comes with it).

```bash
git clone <repository-url>
cd sanklean
npm install
npm run dev
```

Other commands:

```bash
npm run build    # type-check and produce a production build in dist/
npm run preview  # serve the production build locally
npm run lint     # run the linter
```

## Tech stack

- Vite + React 19 + TypeScript
- `@xyflow/react` (canvas: drag / zoom / pan / select / connect)
- `zustand` + `persist` (diagram in `sanklean:v1`, appearance in `sanklean:appearance:v1`)
- Domain model in `src/domain/types.ts`, translated to React Flow only via `src/adapters/reactflow.ts`

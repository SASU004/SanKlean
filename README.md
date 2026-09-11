# SanKlean

A simple, clean alternative to creating Sankey diagrams without coding them or working with rigid templates and spreadsheets.

## What

SanKlean is a free-form Sankey diagram builder inspired by the simplicity of whiteboard tools.

Create nodes, connect them, edit values, and visually track how quantities move through a process — without writing code or maintaining a separate spreadsheet.

## How

SanKlean is inspired by tools like Excalidraw.

Instead of filling out a predefined template, you can:

- Add nodes wherever you want
- Connect nodes to represent flows
- Edit values directly on the diagram
- Move and arrange elements freely
- Select and delete elements
- Switch between light/dark themes and fonts

The diagram is built directly on the canvas, so the visual representation and the data stay together.

## Why

I built SanKlean because I wanted a simpler way to create Sankey diagrams.

While working on my own application/internship tracking, I wanted to visualize things like:

`Applications → Replies → Assessments → Interviews → Offers`

and understand where applications were moving forward, getting rejected, or being ghosted.

Most Sankey tools I found required either writing code, working with a predefined template, or editing data in a spreadsheet alongside the diagram.

SanKlean is an attempt at making that process more direct.

If you find a better way to solve this problem, I'd genuinely like to know. Suggestions and criticism are welcome.

## Setup

```bash
npm install
npm run dev

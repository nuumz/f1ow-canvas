# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-02-27

### 🎉 First Public Release

Full-featured interactive canvas toolkit for React, built on KonvaJS.

### Features

- **10 Drawing Tools** — Rectangle, Ellipse, Diamond, Line, Arrow, Free Draw, Text, Image, Eraser
- **Smart Connectors** — Arrows and lines snap to shapes with auto-routing (sharp, curved, elbow)
- **11 Arrowhead Variants** — Triangle, circle, diamond, bar, crow's foot (ERD), and more
- **Selection & Transform** — Click, drag, resize, rotate, multi-select, group/ungroup, lock/unlock
- **Pan & Zoom** — Hand tool, scroll-wheel, trackpad pinch, zoom-to-fit, zoom-to-selection
- **Rich Styling** — Stroke, fill, width, dash, opacity, roughness, fonts
- **Customizable UI** — Floating toolbar (top/bottom/hidden), style panel, context menu
- **Undo / Redo** — 100-step history snapshot system
- **Export** — PNG, SVG, and JSON
- **Annotations Overlay** — DOM-based annotation badges on canvas elements via `renderAnnotation` prop
- **Real-Time Collaboration** — Optional CRDT via Yjs with cursor presence (experimental)
- **Plugin / Extension System** — Register custom element types with validation and defaults
- **Element Validation** — Every mutation path validated; invalid elements rejected gracefully
- **Worker-based Performance** — Elbow routing and SVG export offloaded to Web Workers
- **Progressive Rendering** — Time-sliced initial load for large canvases
- **Tile-Based & WebGL Rendering** — Optional rendering backends for extreme scale
- **Next.js Compatible** — Auto-fallback to sync mode; optional worker config prop
- **Fully Themeable** — Dark mode, custom colors, all via props
- **Zero CSS Dependencies** — No external stylesheets required
- **TypeScript** — Full type safety with strict mode

### Architecture

- Zustand state management (two stores: canvas + linear edit)
- react-konva rendering with bitmap-cached static layer
- Fractional indexing for CRDT-compatible z-ordering
- Spatial indexing (R-tree) for viewport culling and hit testing
- Batched drag updates with microtask flushing

[1.0.0]: https://github.com/nuumz/f1ow-canvas/releases/tag/v1.0.0

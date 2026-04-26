# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-04-26

### Changed

- **Distribution hardening** — Library bundles are now minified with esbuild, source maps are no longer published, `console.*` and `debugger` statements are dropped, and legal/license comment blocks are stripped. Public API and types are unchanged.

### Notes

- Bundle size shrinks (≈ 30-40% gzip) and internal symbol names are no longer readable in shipped code. JavaScript shipped over npm cannot be made fully reverse-engineering proof; this release simply raises the bar.

### Added

- **Markdown text rendering** — Text elements render markdown (bold, italic, lists, links, inline/block code) with HTML overlay; double-click to edit inline and serialize back to markdown.
- **Bound text on shapes** — Double-click a shape to attach a centered text label that follows the shape under move/resize/delete.
- **Cross-layer double-click** — Double-clicking a text label routes to its container shape's edit affordance.
- **Elbow routing improvements** — Obstacle-aware routing with alternate direction pairs and relaxed-margin fallback when the primary route is blocked.
- **Center binding indicator** — Connection points expose a center anchor for shapes that prefer center-bound connectors.
- **Animation hook** — `useFlowAnimation` exposes Konva-friendly RAF animation primitive.
- **SVG export fallback** — Export gracefully degrades when worker-based SVG generation fails.

### Changed

- React peer dependency upgraded; types updated to match.
- Worker URL resolution preserves relative paths so Next.js / non-Vite bundlers stay correct.
- Vite/Vitest configuration: collaboration entry built separately; tests run under `happy-dom`.
- Renderer instance-data management refactored for lower per-frame allocation.

### Fixed

- Connector label position when binding shifts mid-drag.
- Text element z-order preserved across edit cycles.

### Tests

- Added test coverage for canvas store, export worker manager, AI canvas demo, agent bridge, text tool, text binding, markdown helpers, and editable target detection.

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

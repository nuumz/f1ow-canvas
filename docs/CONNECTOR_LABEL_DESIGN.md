# Connector Label System — Design Document

## Overview

Connector labels are editable text elements bound to arrows/lines via the `containerId` relationship. They float at the connector's midpoint inside a white "pill" background. This document describes the current architecture, the tldraw reference approach, identified gaps, and the plan to achieve **pixel-perfect consistency between display and editing modes**.

---

## Goals

1. **Auto-fit sizing** — The pill background shrinks/expands to hug the text content exactly (no fixed minimum width).
2. **Display ↔ Edit consistency** — The label must look identical in both modes: same size, same position, same padding, same font metrics.
3. **Follow connector movement** — Labels reposition in real-time during connector drag, point editing, and binding updates.
4. **Minimal visual disruption** — Edit handles on the connector line that overlap the label area are hidden.

---

## tldraw Reference Architecture

tldraw uses a **single HTML component (`RichTextLabel`)** for both display and editing:

### Key Components (tldraw)

| Component | Role |
|---|---|
| `ArrowShapeUtil` | Orchestrator — computes label position, renders clip path + `RichTextLabel` |
| `arrowLabel.ts` | `getArrowLabelSize()` and `getArrowLabelPosition()` pure functions |
| `RichTextLabel` | **Single component** rendering both display (`dangerouslySetInnerHTML`) and edit (`RichTextArea`) modes |
| `textMeasure` | HTML-based text measurement (`measureHtml()`) for accurate sizing |

### How tldraw achieves consistency

1. **Unified renderer**: `RichTextLabel` wraps both display and edit content in the **same container div** with identical `width` / `min-width` / `height` CSS. The display div and the editing textarea share the same wrapper — so sizing never diverges.

2. **HTML text measurement**: `editor.textMeasure.measureHtml(html, { maxWidth, ... })` returns pixel-accurate `{ w, h }` from a hidden DOM element. This drives the pill size.

3. **Computed cache**: `labelSizeCache = createComputedCache(...)` memoizes label dimensions. Invalidates when text, font, or arrow bounds change.

4. **Position via path interpolation**: `getArrowLabelPosition()` → `bodyGeom.interpolateAlongEdge(labelPosition)` → `Box.FromCenter(center, size)` centers the label along the arrow path at a configurable `labelPosition` ratio (default 0.5 = midpoint).

5. **Clip path**: An SVG clip path cuts the arrow line behind the label area so the line doesn't visually intersect the pill.

---

## Current Architecture (f1ow-canvas)

### Rendering Stack

| Mode | Technology | Sizing Source |
|---|---|---|
| **Display** | Konva `<Text>` + `<Rect>` in a `<Group>` | Konva `textNode.getTextWidth()` via `syncSize()` callback |
| **Edit** | DOM `<textarea>` overlay | `textarea.scrollWidth` / `scrollHeight` via `autoGrow()` |

### Problem: Dual Rendering Paths

The display mode uses **Konva's text engine** (canvas 2D `measureText`) while editing uses the **browser's CSS/DOM layout engine** (`<textarea>`). These two engines have inherently different:

- **Font metric computation** — canvas `measureText` vs CSS line-height model
- **Line-height interpretation** — Konva uses `lineHeight` as a multiplier on `fontSize`, CSS uses it differently with leading distribution
- **Width calculation** — Konva `getTextWidth()` vs `textarea.scrollWidth` (includes padding, border-box model)
- **Baseline alignment** — Konva `textBaseline='top'` vs CSS default with half-leading

This causes visual "jumps" when toggling between display and edit modes — the text may shift position and the pill may change size.

### Current Mitigations

- `halfLeading` offset compensates for CSS leading vs Konva baseline
- `CONNECTOR_LABEL_PADDING_*` constants are manually scaled by `stageScaleX` in the textarea
- `autoGrow()` re-centers the textarea after width changes
- `syncSize()` persists Konva-measured width back to the store

These are **approximations** — they minimize the gap but don't eliminate it.

---

## Proposed Solution

### Strategy: Shared Measurement Source

Since we cannot switch to a single HTML component (Konva's `<Stage>` renders to `<canvas>`, not DOM), we instead **share measurement constants and formulas** between both paths:

#### 1. Centralized Label Metrics Module

Create `src/utils/labelMetrics.ts`:

```typescript
/** Padding, corner radius, and sizing constants for connector labels */
export const LABEL_PADDING_H = 8;
export const LABEL_PADDING_V = 4;
export const LABEL_CORNER = 4;
export const LABEL_LINE_HEIGHT = 1.18;
export const LABEL_MIN_WIDTH = 10;

/**
 * Measure text width using a hidden canvas context.
 * This is the SINGLE SOURCE OF TRUTH for text width measurement,
 * used by both Konva display and DOM textarea editor.
 */
export function measureLabelText(
  text: string,
  fontSize: number,
  fontFamily: string,
): { width: number; height: number } {
  // Use OffscreenCanvas or shared <canvas> element for measurement
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const metrics = ctx.measureText(text);
  return {
    width: Math.ceil(metrics.width),
    height: Math.ceil(fontSize * LABEL_LINE_HEIGHT),
  };
}

/**
 * Compute the pill dimensions given text content.
 */
export function computePillSize(
  textWidth: number,
  textHeight: number,
): { width: number; height: number } {
  return {
    width: Math.max(LABEL_MIN_WIDTH, textWidth) + LABEL_PADDING_H * 2,
    height: textHeight + LABEL_PADDING_V * 2,
  };
}
```

#### 2. Display Path (Konva)

The Konva `<Text>` node already uses canvas-based measurement internally. `syncSize()` calls `node.getTextWidth()` which uses `CanvasRenderingContext2D.measureText()` — this is consistent with our `measureLabelText()` helper.

No change needed in the display path beyond importing shared constants.

#### 3. Edit Path (Textarea)

The textarea must be sized to match the **canvas measurement**, not its own CSS layout:

```typescript
// In openEditor():
const measured = measureLabelText(text, style.fontSize, style.fontFamily);
const scaledTextW = measured.width * stageScaleX;
const scaledPadH = LABEL_PADDING_H * stageScaleX;
const scaledPadV = LABEL_PADDING_V * stageScaleX;

// Set textarea width to match Konva text width exactly
textarea.style.width = `${scaledTextW + scaledPadH * 2}px`;
// Override CSS box model to match canvas rendering:
textarea.style.boxSizing = 'border-box';
textarea.style.padding = `${scaledPadV}px ${scaledPadH}px`;
```

In `autoGrow()`, re-measure using the same canvas function:

```typescript
const autoGrow = () => {
  const currentText = textarea.value || ' ';
  const measured = measureLabelText(currentText, style.fontSize, style.fontFamily);
  const newW = Math.max(LABEL_MIN_WIDTH, measured.width) * stageScaleX;
  const pillW = newW + scaledPadH * 2;
  textarea.style.width = `${pillW}px`;

  // Height: use canvas measurement, not textarea.scrollHeight
  const newH = measured.height * stageScaleX + scaledPadV * 2;
  textarea.style.height = `${newH}px`;

  // Re-center over connector midpoint
  const midScreenX = absPos.x + (nodeWidth * stageScaleX) / 2;
  textarea.style.left = `${midScreenX - pillW / 2}px`;
};
```

#### 4. Positioning Alignment

Both display and edit must position from the same origin:

- **Display**: Group at `(effectiveX - padH, effectiveY - padV)`, text at `(padH, padV)` inside Group
- **Edit**: Textarea at `(groupScreenX, groupScreenY)` where `groupScreenX = absGroupTransform.point({x:0, y:0}).x`

The current `halfLeading` compensation for CSS is eliminated because we force the textarea to match canvas dimensions, not rely on CSS flow.

---

## Implementation Checklist

1. [ ] **Extract shared constants** — Move `CONNECTOR_LABEL_PADDING_*`, `CONNECTOR_LABEL_CORNER`, `LINE_HEIGHT` from TextShape.tsx to `utils/labelMetrics.ts`
2. [ ] **Create `measureLabelText()`** — Canvas-based text measurement function
3. [ ] **Create `computePillSize()`** — Pill dimension calculator
4. [ ] **Refactor TextShape display** — Import from labelMetrics, use shared constants
5. [ ] **Refactor TextShape editor** — Use `measureLabelText()` for textarea sizing instead of `scrollWidth`/`scrollHeight`
6. [ ] **Fix textarea positioning** — Use Group's absolute transform (not text child's) for consistent origin
7. [ ] **Update autoGrow** — Re-measure via canvas API, re-center pill
8. [ ] **Update LinearElementHandles** — Import shared constants instead of hardcoded values
9. [ ] **Typecheck + manual test** — Verify visual consistency across modes

---

## Diagram: Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                   labelMetrics.ts                         │
│  ┌───────────────┐  ┌─────────────────┐  ┌───────────┐  │
│  │ Constants      │  │ measureLabelText│  │ pillSize  │  │
│  │ PAD_H, PAD_V  │  │ (canvas 2D)    │  │ calculator│  │
│  │ CORNER, LH    │  │                 │  │           │  │
│  └───────┬───────┘  └────────┬────────┘  └─────┬─────┘  │
│          │                   │                  │        │
└──────────┼───────────────────┼──────────────────┼────────┘
           │                   │                  │
    ┌──────┴──────┐     ┌──────┴──────┐    ┌──────┴──────┐
    │  TextShape  │     │  TextShape  │    │ LinearElem  │
    │  (display)  │     │  (editor)   │    │  Handles    │
    │  Konva      │     │  textarea   │    │             │
    └─────────────┘     └─────────────┘    └─────────────┘
```

---

## Trade-offs

| Approach | Pros | Cons |
|---|---|---|
| **tldraw: Single HTML component** | Perfect consistency, single code path | Requires HTML/SVG rendering (not canvas) |
| **Ours: Shared canvas measurement** | Works with Konva canvas, minimal refactor | Still two renderers — edge cases possible (e.g., emoji, complex Unicode) |
| **Alternative: HTML overlay for display** | Would match tldraw approach | Major architectural change, performance cost for many labels |

We chose **shared canvas measurement** as the pragmatic middle ground — it achieves near-perfect consistency within the existing Konva architecture without a major rewrite.

---

## References

- [tldraw ArrowShapeUtil.tsx](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/shapes/arrow/ArrowShapeUtil.tsx)
- [tldraw arrowLabel.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/shapes/arrow/arrowLabel.ts)
- [tldraw RichTextLabel.tsx](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/shapes/shared/RichTextLabel.tsx)
- [Konva Editable Text](https://konvajs.org/docs/sandbox/Editable_Text.html)

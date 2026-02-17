# Next.js Integration Guide

## Overview

f1ow-canvas uses Web Workers for performance-intensive operations (elbow connector routing and SVG export). When using f1ow-canvas in **Next.js** or other non-Vite bundlers, you need to configure worker URLs manually because these bundlers handle assets differently than Vite.

## The Problem

- **Vite** bundles workers as separate files in `/assets/` with automatic path resolution
- **Next.js** cannot resolve these Vite-generated paths automatically
- Workers will fail to load, falling back to synchronous (main-thread) processing

## Solution Options

### Option 1: Auto Fallback (Easiest)

Simply omit the `workerConfig` prop. f1ow-canvas will automatically detect worker loading failures and fall back to synchronous processing on the main thread.

```tsx
import { FlowCanvas } from 'f1ow-canvas';

export default function MyCanvas() {
  return <FlowCanvas />; // Workers auto-fallback in Next.js
}
```

**Pros:**
- Zero configuration
- Works immediately in Next.js
- Automatic fallback on error

**Cons:**
- Slower performance on large canvases (sync mode)
- No Web Worker acceleration

---

### Option 2: Copy Worker Files (Best Performance)

For production apps with large canvases (100+ elements, complex elbow routing), enable workers by copying worker files to your Next.js `public/` directory.

#### Step 1: Copy Worker Files

After installing f1ow-canvas, copy worker files from `node_modules/f1ow-canvas/dist/assets/` to your `public/workers/` directory:

```bash
# From your Next.js project root
mkdir -p public/workers
cp node_modules/f1ow-canvas/dist/assets/elbowWorker-*.js public/workers/elbowWorker.js
cp node_modules/f1ow-canvas/dist/assets/exportWorker-*.js public/workers/exportWorker.js
```

**Note:** Worker filenames include content hashes (e.g., `elbowWorker-a1b2c3d4.js`). You can rename them to static names (`elbowWorker.js`) for easier reference.

#### Step 2: Configure FlowCanvas

Pass worker URLs via the `workerConfig` prop:

```tsx
import { FlowCanvas } from 'f1ow-canvas';

export default function MyCanvas() {
  return (
    <FlowCanvas
      workerConfig={{
        elbowWorkerUrl: '/workers/elbowWorker.js',
        exportWorkerUrl: '/workers/exportWorker.js',
      }}
    />
  );
}
```

**Pros:**
- Full Web Worker acceleration
- Best performance for large canvases
- Smooth 60fps elbow routing during drag

**Cons:**
- Manual setup step required
- Worker files must be kept in sync when updating f1ow-canvas

---

### Option 3: Disable Workers Explicitly

Force synchronous mode without worker loading attempts:

```tsx
import { FlowCanvas } from 'f1ow-canvas';

export default function MyCanvas() {
  return (
    <FlowCanvas
      workerConfig={{
        disabled: true, // Force sync mode, never try workers
      }}
    />
  );
}
```

Use this when:
- You know workers won't work in your environment
- You want to reduce console warnings in development
- Your canvas is small (<50 elements) where workers add overhead

---

## Performance Implications

### With Workers (Option 2)
- **Elbow routing:** ~5-10ms per connector (off main thread)
- **SVG export:** ~200ms for 1000 elements (off main thread)
- **Main thread:** Free to handle UI interactions at 60fps

### Without Workers (Option 1 / 3)
- **Elbow routing:** ~5-10ms per connector (blocks main thread)
- **SVG export:** ~200ms for 1000 elements (blocks main thread)
- **Main thread:** May drop frames during intensive operations

**Recommendation:**
- Small canvases (<50 elements): Option 1 (auto fallback) is fine
- Large canvases (>100 elements): Option 2 (copy workers) recommended

---

## Troubleshooting

### "Worker construction failed" warnings in console

**Cause:** Next.js cannot resolve Vite's worker paths.

**Solution:** Use Option 2 (copy workers) or ignore the warnings (auto-fallback will work).

### Workers not accelerating elbow routing

**Verify:**
1. Worker files exist at the URLs you specified
2. Browser console shows no 404 errors for worker files
3. Worker files have correct MIME type (`application/javascript`)

**Debug:**
```tsx
const workerConfig = {
  elbowWorkerUrl: '/workers/elbowWorker.js',
  exportWorkerUrl: '/workers/exportWorker.js',
};

console.log('Worker config:', workerConfig);
```

### Next.js SSR hydration issues

Workers are only instantiated on the client side. SSR works fine — workers initialize after hydration.

---

## API Reference

### `workerConfig` Prop

```typescript
interface WorkerConfig {
  /** Custom URL for elbow routing worker */
  elbowWorkerUrl?: string;
  
  /** Custom URL for SVG export worker */
  exportWorkerUrl?: string;
  
  /** Disable all workers (force sync mode) */
  disabled?: boolean;
}
```

### Example: Environment-Based Config

```tsx
const workerConfig = process.env.NODE_ENV === 'production'
  ? {
      elbowWorkerUrl: '/workers/elbowWorker.js',
      exportWorkerUrl: '/workers/exportWorker.js',
    }
  : undefined; // Auto-fallback in dev

<FlowCanvas workerConfig={workerConfig} />
```

---

## Webpack / Other Bundlers

The same approach works for **Webpack**, **Parcel**, **esbuild**, or any bundler that doesn't natively support Vite's worker URL pattern:

1. Copy worker files to your public/static assets directory
2. Pass URLs via `workerConfig`
3. Or rely on auto-fallback (no config needed)

---

## Questions?

- **GitHub Issues:** https://github.com/nuumz/f1ow-canvas/issues


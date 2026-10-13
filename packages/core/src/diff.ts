import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export function hashPng(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface DiffResult {
  changed: boolean;
  diffPixels: number;
  /** Fraction of pixels that differ, 0..1. */
  ratio: number;
  sizeChanged: boolean;
  width: number;
  height: number;
  diffPng?: Buffer;
}

/**
 * Compare two PNGs. Images of different sizes are padded onto a shared canvas so the
 * diff still shows where content moved; a size change always counts as a change.
 */
export function diffPngs(baseline: Buffer, current: Buffer, threshold = 0.1): DiffResult {
  if (hashPng(baseline) === hashPng(current)) {
    const img = PNG.sync.read(current);
    return { changed: false, diffPixels: 0, ratio: 0, sizeChanged: false, width: img.width, height: img.height };
  }
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  const pa = sizeChanged ? pad(a, width, height) : a;
  const pb = sizeChanged ? pad(b, width, height) : b;
  const out = new PNG({ width, height });
  const diffPixels = pixelmatch(pa.data, pb.data, out.data, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.2,
    diffColor: [255, 0, 80],
  });
  const changed = sizeChanged || diffPixels > 0;
  return {
    changed,
    diffPixels,
    ratio: diffPixels / (width * height),
    sizeChanged,
    width,
    height,
    diffPng: changed ? PNG.sync.write(out) : undefined,
  };
}

function pad(img: PNG, width: number, height: number): PNG {
  const out = new PNG({ width, height, fill: true });
  out.data.fill(0);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

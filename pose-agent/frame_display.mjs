// Turn a caller camera frame into the RGBA size the agent publishes.
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';

/**
 * Default crop strips typical FaceTime chrome (bottom controls / PiP margins).
 * Fractions of the source frame to cut on each side.
 * Never stretch the result — save/preview keep the cropped aspect ratio.
 */
export const FACETIME_CROP = {
  left: 0.04,
  right: 0.04,
  top: 0.03,
  bottom: 0.18,
};

const PREVIEW_FILL = [16, 40, 52];

/**
 * Nearest-neighbor scale of an RGBA buffer into WIDTH x HEIGHT (may stretch).
 * Prefer containRgba for on-screen previews.
 * @param {Uint8Array} src
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8Array}
 */
export function scaleRgba(src, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

/**
 * Letterbox/pillarbox an RGBA buffer into dstW x dstH without distorting.
 * @param {Uint8Array} src
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {number[]} [fill]
 * @returns {Uint8Array}
 */
export function containRgba(src, srcW, srcH, dstW, dstH, fill = PREVIEW_FILL) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const drawW = Math.max(1, Math.round(srcW * scale));
  const drawH = Math.max(1, Math.round(srcH * scale));
  const ox = Math.floor((dstW - drawW) / 2);
  const oy = Math.floor((dstH - drawH) / 2);
  const scaled = (drawW === srcW && drawH === srcH)
    ? src
    : scaleRgba(src, srcW, srcH, drawW, drawH);
  const out = new Uint8Array(dstW * dstH * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = fill[0];
    out[i + 1] = fill[1];
    out[i + 2] = fill[2];
    out[i + 3] = 255;
  }
  for (let y = 0; y < drawH; y++) {
    const srcRow = y * drawW * 4;
    const dstRow = ((oy + y) * dstW + ox) * 4;
    out.set(scaled.subarray(srcRow, srcRow + drawW * 4), dstRow);
  }
  return out;
}

/**
 * Crop FaceTime UI chrome out of an RGBA buffer.
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {{ left?: number, right?: number, top?: number, bottom?: number }} [margins]
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
export function cropFacetimeRgba(src, width, height, margins = FACETIME_CROP) {
  const left = Math.max(0, Math.floor(width * (margins.left ?? 0)));
  const right = Math.max(left + 1, Math.floor(width * (1 - (margins.right ?? 0))));
  const top = Math.max(0, Math.floor(height * (margins.top ?? 0)));
  const bottom = Math.max(top + 1, Math.floor(height * (1 - (margins.bottom ?? 0))));
  const outW = right - left;
  const outH = bottom - top;
  const data = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const srcRow = ((top + y) * width + left) * 4;
    data.set(src.subarray(srcRow, srcRow + outW * 4), y * outW * 4);
  }
  return { data, width: outW, height: outH };
}

/**
 * Convert, crop FaceTime chrome, and letterbox into the agent canvas size.
 * Does not stretch — bars fill unused space so the snap stays proportional.
 * @param {import('@livekit/rtc-node').VideoFrame} frame
 * @param {number} width
 * @param {number} height
 * @param {{ margins?: typeof FACETIME_CROP, fill?: number[] }} [options]
 * @returns {Uint8Array}
 */
export function frameToAgentRgba(frame, width, height, options = {}) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  const cropped = cropFacetimeRgba(rgba.data, rgba.width, rgba.height, options.margins);
  if (cropped.width === width && cropped.height === height) return cropped.data;
  return containRgba(cropped.data, cropped.width, cropped.height, width, height, options.fill);
}

/**
 * Build a cropped VideoFrame suitable for pose inference input / save.
 * Keeps the cropped pixel aspect — callers must not stretch it to a square.
 * @param {import('@livekit/rtc-node').VideoFrame} frame
 * @param {{ margins?: typeof FACETIME_CROP }} [options]
 * @returns {VideoFrame}
 */
export function cropFacetimeFrame(frame, options = {}) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  const cropped = cropFacetimeRgba(rgba.data, rgba.width, rgba.height, options.margins);
  return new VideoFrame(cropped.data, cropped.width, cropped.height, VideoBufferType.RGBA);
}

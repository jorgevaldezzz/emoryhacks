// Turn a caller camera frame into the RGBA size the agent publishes.
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';

/**
 * Default crop strips typical FaceTime chrome (bottom controls / PiP margins).
 * Fractions of the source frame to cut on each side.
 */
export const FACETIME_CROP = {
  left: 0.04,
  right: 0.04,
  top: 0.03,
  bottom: 0.18,
};

/**
 * Nearest-neighbor scale of an RGBA buffer into WIDTH x HEIGHT.
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
 * Convert, crop FaceTime chrome, and scale to the agent canvas size.
 * @param {import('@livekit/rtc-node').VideoFrame} frame
 * @param {number} width
 * @param {number} height
 * @param {{ margins?: typeof FACETIME_CROP }} [options]
 * @returns {Uint8Array}
 */
export function frameToAgentRgba(frame, width, height, options = {}) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  const cropped = cropFacetimeRgba(rgba.data, rgba.width, rgba.height, options.margins);
  if (cropped.width === width && cropped.height === height) return cropped.data;
  return scaleRgba(cropped.data, cropped.width, cropped.height, width, height);
}

/**
 * Build a cropped VideoFrame suitable for vision encode / save.
 * @param {import('@livekit/rtc-node').VideoFrame} frame
 * @param {{ margins?: typeof FACETIME_CROP }} [options]
 * @returns {VideoFrame}
 */
export function cropFacetimeFrame(frame, options = {}) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  const cropped = cropFacetimeRgba(rgba.data, rgba.width, rgba.height, options.margins);
  return new VideoFrame(cropped.data, cropped.width, cropped.height, VideoBufferType.RGBA);
}

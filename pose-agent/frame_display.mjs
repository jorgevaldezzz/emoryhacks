// Turn a caller camera frame into the RGBA size the agent publishes.
import { VideoBufferType } from '@livekit/rtc-node';

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
 * @param {import('@livekit/rtc-node').VideoFrame} frame
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function frameToAgentRgba(frame, width, height) {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
  if (rgba.width === width && rgba.height === height) {
    return new Uint8Array(rgba.data);
  }
  return scaleRgba(rgba.data, rgba.width, rgba.height, width, height);
}

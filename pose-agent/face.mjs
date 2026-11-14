// The picture your caller sees: reference skeleton on a dark stage, plus shutter flash.
import { drawSampleSkeleton } from './skeleton.mjs';

export const WIDTH = 640;
export const HEIGHT = 360;
export const FPS = 15;

const BACKGROUND = [16, 40, 52];
const ACCENT = [255, 200, 118];

/**
 * Agent video frame. `speaking` pulses a bottom bar; `snapping` is a white shutter;
 * `countdown` (3|2|1) draws a large digit while the 3-2-1 runs.
 * Returns WIDTH x HEIGHT pixels, four bytes each: red, green, blue, alpha.
 */
export function drawFace(tick, speaking = false, snapping = false, countdown = 0) {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  const bar = (tick * 6) % (WIDTH - 40);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let color = BACKGROUND;
      if (speaking && y > HEIGHT - 18 && y < HEIGHT - 10 && x > bar && x < bar + 40) color = ACCENT;
      if (snapping) color = [255, 255, 255];
      const i = (y * WIDTH + x) * 4;
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
    }
  }
  if (!snapping) {
    drawSampleSkeleton(pixels, { width: WIDTH, height: HEIGHT });
    if (countdown >= 1 && countdown <= 3) drawCountdownDigit(pixels, countdown);
  }
  return pixels;
}

/**
 * @param {Uint8Array} pixels
 * @param {number} digit
 */
function drawCountdownDigit(pixels, digit) {
  // Simple block digits centered on the stage.
  const glyphs = {
    1: ['..#.', '..#.', '..#.', '..#.', '..#.'],
    2: ['####', '...#', '####', '#...', '####'],
    3: ['####', '...#', '####', '...#', '####'],
  };
  const glyph = glyphs[digit];
  if (!glyph) return;
  const cell = 28;
  const gw = glyph[0].length * cell;
  const gh = glyph.length * cell;
  const ox = Math.floor((WIDTH - gw) / 2);
  const oy = Math.floor((HEIGHT - gh) / 2);
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col] !== '#') continue;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const px = ox + col * cell + x;
          const py = oy + row * cell + y;
          if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) continue;
          const i = (py * WIDTH + px) * 4;
          pixels[i] = 255; pixels[i + 1] = 200; pixels[i + 2] = 118; pixels[i + 3] = 255;
        }
      }
    }
  }
}

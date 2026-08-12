// Regenerates the committed image fixtures. Run from packages/image:
//   node test/fixtures/generate.mjs
// Every fixture must stay tiny (<5KB) — they are committed to the repo.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));

// A tiny landscape gradient: 32x20 JPEG.
const gradient = Buffer.alloc(32 * 20 * 3);
for (let y = 0; y < 20; y += 1) {
  for (let x = 0; x < 32; x += 1) {
    const i = (y * 32 + x) * 3;
    gradient[i] = Math.round((x / 31) * 255);
    gradient[i + 1] = 80;
    gradient[i + 2] = Math.round((y / 19) * 255);
  }
}
const raw = { raw: { width: 32, height: 20, channels: 3 } };

await sharp(gradient, raw).jpeg({ quality: 80 }).toFile(join(here, "landscape.jpg"));

// Same pixels, EXIF orientation 6 (rotate 90° CW on display): the raster is
// 32x20 but the image *displays* as 20x32.
await sharp(gradient, raw)
  .jpeg({ quality: 80 })
  .withMetadata({ orientation: 6 })
  .toFile(join(here, "exif-rotated.jpg"));

// CMYK colorspace JPEG.
await sharp(gradient, raw)
  .toColourspace("cmyk")
  .jpeg({ quality: 80 })
  .toFile(join(here, "cmyk.jpg"));

// Animated GIF: 3 frames of 16x16 solid colors, joined as an animation.
const frame = (r, g, b) =>
  sharp({ create: { width: 16, height: 16, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
const framePngs = await Promise.all([frame(255, 0, 0), frame(0, 255, 0), frame(0, 0, 255)]);
await sharp(framePngs, { join: { animated: true } })
  .gif({ delay: [100, 100, 100] })
  .toFile(join(here, "animated.gif"));

// The SVG is hand-written.
await writeFile(
  join(here, "icon.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="48" height="24" fill="#7c3aed"/></svg>\n',
);

// One-time: turn the white logo background transparent and isolate the
// circular drone emblem (drops the embedded wordmark so a crisp text wordmark
// can sit beside it). Output: public/logo-mark.png
// Run with: node scripts/process-logo.mjs
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = join(root, "logo.png");

const WHITE = 236; // pixels brighter than this on all channels become transparent

const { data, info } = await sharp(input)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const { width, height, channels } = info;

// 1) key out near-white -> transparent
for (let i = 0; i < data.length; i += channels) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  if (r >= WHITE && g >= WHITE && b >= WHITE) {
    data[i + 3] = 0;
  }
}

// 2) crop the upper region (circular emblem only, above the wordmark),
//    then trim the surrounding transparency so the circle sits snug.
const box = {
  left: Math.round(width * 0.07),
  top: Math.round(height * 0.015),
  width: Math.round(width * 0.86),
  height: Math.round(height * 0.69),
};

const cropped = await sharp(data, { raw: { width, height, channels } })
  .extract(box)
  .png()
  .toBuffer();

await sharp(cropped)
  .trim({ threshold: 10 })
  .png()
  .toFile(join(root, "public", "logo-mark.png"));

console.log("wrote public/logo-mark.png from", box);

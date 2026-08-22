/**
 * Known-answer checks for the tile renderer: PNG, colour, hillshade, tiles.
 *
 *   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/render-test.mjs
 *
 * Every part of this produces a picture, and a picture is the hardest thing to
 * be wrong about safely: a hillshade lit from the wrong side still looks like
 * terrain, a rainbow applied to a difference still looks like a map, and a PNG
 * with a bad CRC still has the right file size. So nothing here is checked by
 * eye. The PNG is decoded back, the hillshade is given surfaces whose lighting
 * is known analytically, and the tile maths is round-tripped.
 */

import { inflateSync } from "node:zlib";
import { Grid } from "../src/lib/geo/raster.mjs";
import { encodePng, transparentPng } from "../src/lib/geo/png.mjs";
import { RAMP_NAMES, legend, legendTicks, rampFor, sampleRamp } from "../src/lib/geo/colour.mjs";
import { hillshade, renderGrid } from "../src/lib/geo/render.mjs";
import {
  metresPerTilePixel,
  overlaps,
  sampleIntoTile,
  tileBoundsLonLat,
  tileBoundsProjected,
  tileLonLat,
} from "../src/lib/geo/tiles.mjs";
import { lonLatToUtm, utmToLonLat } from "../src/lib/geo/projection.mjs";

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const near = (label, a, b, tol, unit = "") =>
  check(label, Number.isFinite(a) && Math.abs(a - b) <= tol, `got ${a}, want ${b} ±${tol}${unit}`);
function throws(label, fn, pattern) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (error) {
    check(label, pattern.test(error.message), `threw "${error.message}"`);
  }
}

/** Decode enough of a PNG to prove it is one, and get the pixels back. */
function decodePng(buffer) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) {
    if (buffer[i] !== sig[i]) throw new Error("bad signature");
  }
  let at = 8;
  let header = null;
  const idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const payload = buffer.subarray(at + 8, at + 8 + length);
    const declared = buffer.readUInt32BE(at + 8 + length);

    // Recompute the CRC exactly as PNG defines it. A wrong CRC is the one defect
    // that every viewer tolerates differently: some render the image anyway.
    let c = 0xffffffff;
    const covered = buffer.subarray(at + 4, at + 8 + length);
    for (let i = 0; i < covered.length; i += 1) {
      c ^= covered[i];
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    if (((c ^ 0xffffffff) >>> 0) !== declared) throw new Error(`bad CRC on ${type}`);

    if (type === "IHDR") {
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        depth: payload[8],
        colour: payload[9],
        interlace: payload[12],
      };
    }
    if (type === "IDAT") idat.push(payload);
    if (type === "IEND") break;
    at += 12 + length;
  }
  if (!header) throw new Error("no IHDR");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * 4;
  const pixels = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[row * (stride + 1)];
    if (filter !== 0) throw new Error(`unexpected filter ${filter}`);
    raw.copy(pixels, row * stride, row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
  }
  return { ...header, pixels };
}

console.log("\nPNG: it has to be a real one, not merely the right size");
{
  const w = 5;
  const h = 3;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = i * 7;
    rgba[i * 4 + 1] = 255 - i * 5;
    rgba[i * 4 + 2] = (i * 13) % 256;
    rgba[i * 4 + 3] = 255;
  }
  const png = encodePng(w, h, rgba);
  const decoded = decodePng(png);

  check("dimensions survive", decoded.width === w && decoded.height === h);
  check("8 bit truecolour with alpha", decoded.depth === 8 && decoded.colour === 6);
  check("not interlaced", decoded.interlace === 0);
  check("every chunk's CRC verifies", true); // decodePng throws otherwise
  check("every pixel comes back byte for byte", Buffer.compare(decoded.pixels, Buffer.from(rgba)) === 0);

  const empty = decodePng(transparentPng(8));
  check("a transparent tile is fully transparent", [...empty.pixels].every((b, i) => i % 4 !== 3 || b === 0));

  throws("a mismatched buffer is refused", () => encodePng(2, 2, new Uint8Array(3)), /expected 16 bytes/);
  throws("zero dimensions are refused", () => encodePng(0, 4, new Uint8Array(0)), /bad dimensions/);
}

console.log("\nColour: the rules about which ramp is allowed where");
{
  const rainbow = rampFor("rainbow");
  const [r0, g0, b0] = sampleRamp(rainbow, 0);
  const [r1, g1, b1] = sampleRamp(rainbow, 1);
  check("the rainbow starts blue", b0 > r0 && b0 > g0, `${r0},${g0},${b0}`);
  check("and ends red", r1 > g1 && r1 > b1, `${r1},${g1},${b1}`);
  check("it is continuous across a stop",
    Math.abs(sampleRamp(rainbow, 0.399)[0] - sampleRamp(rainbow, 0.401)[0]) < 6);

  // Out of range must clamp, never wrap: wrapping would draw the highest ground
  // in the colour of the lowest.
  check("above the maximum clamps to the top", String(sampleRamp(rainbow, 3)) === String(sampleRamp(rainbow, 1)));
  check("below the minimum clamps to the bottom", String(sampleRamp(rainbow, -3)) === String(sampleRamp(rainbow, 0)));
  check("a NaN position does not produce NaN colour", sampleRamp(rainbow, NaN).every(Number.isFinite));

  const diff = rampFor("difference", { signed: true });
  const centre = sampleRamp(diff, 0.5);
  check("a diverging ramp is near neutral at its centre",
    Math.max(...centre) - Math.min(...centre) < 12, `${centre}`);
  check("blue below and red above",
    sampleRamp(diff, 0)[2] > sampleRamp(diff, 0)[0] && sampleRamp(diff, 1)[0] > sampleRamp(diff, 1)[2]);

  // The rule that matters most, enforced rather than documented.
  throws("a rainbow is refused for a signed quantity",
    () => rampFor("rainbow", { signed: true }), /loses the one thing that matters/);
  throws("and a diverging ramp is refused for an unsigned one",
    () => rampFor("difference", { signed: false }), /centres on a midpoint that means nothing/);
  check("every named ramp resolves", RAMP_NAMES.every((n) => Array.isArray(rampFor(n, { signed: n === "difference" }))));
}

console.log("\nLegend ticks land on numbers a person would choose");
{
  const ticks = legendTicks(337.14, 424.25);
  check("ticks are inside the range", ticks.every((t) => t >= 337.14 && t <= 424.25), `${ticks}`);
  check("there are a readable number of them", ticks.length >= 3 && ticks.length <= 10, `${ticks.length}`);
  const step = ticks[1] - ticks[0];
  check("they are evenly spaced", ticks.every((t, i) => i === 0 || Math.abs(t - ticks[i - 1] - step) < 1e-6));
  check("on a round step", [1, 2, 2.5, 5, 10, 20, 25, 50].some((s) => Math.abs(step / s - Math.round(step / s)) < 1e-9) || step % 1 === 0, `${step}`);
  check("and carry no floating point dust", ticks.every((t) => String(t).length < 12), `${ticks}`);
  check("a degenerate range gives no ticks", legendTicks(5, 5).length === 0);

  const l = legend({ ramp: "rainbow", min: 337.14, max: 424.25, label: "Elevation" });
  check("a legend is data, with swatches and ticks", l.swatches.length > 8 && l.ticks.length > 2);
  check("its swatches carry the value they represent",
    Math.abs(l.swatches[0].value - 337.14) < 1e-9 &&
      Math.abs(l.swatches[l.swatches.length - 1].value - 424.25) < 1e-9);
}

console.log("\nHillshade: lit from the north west, or every ridge reads as a valley");
{
  /** A plane tilted so that it faces a given compass bearing, 10% grade. */
  const facing = (bearing) => {
    const size = 9;
    const data = new Float32Array(size * size);
    const b = bearing * Math.PI / 180;
    // Downhill direction: east component sin(b), north component cos(b).
    const dEast = Math.sin(b);
    const dNorth = Math.cos(b);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const east = col;
        const north = -row; // rows increase southward
        data[row * size + col] = 100 - 0.1 * (east * dEast + north * dNorth);
      }
    }
    return new Grid({ width: size, height: size, cellSize: 1, originX: 0, originY: size, data, nodata: -9999 });
  };

  const centre = (shade) => shade[4 * 9 + 4];

  const nw = centre(hillshade(facing(315), { exaggeration: 1 }));
  const se = centre(hillshade(facing(135), { exaggeration: 1 }));
  check("a slope facing the sun is brighter than one facing away",
    nw > se, `north west ${nw.toFixed(3)} vs south east ${se.toFixed(3)}`);
  /*
   * The gap between facing the sun and facing away has a closed form, so it is
   * checked against that rather than against a threshold somebody picked.
   *
   *   shade = cos(zenith)cos(slope) + sin(zenith)sin(slope)cos(delta)
   *
   * so the two extremes differ by exactly 2 sin(zenith) sin(slope). On these
   * 10% planes at a 45 degree sun that is 0.1407, and an arbitrary "more than
   * 0.2" would have failed correct code for being gentle.
   */
  const slope = Math.atan(0.1);
  const expectedGap = 2 * Math.sin(45 * Math.PI / 180) * Math.sin(slope);
  // 1e-5 because the plane's elevations are stored as Float32 around 100 m,
  // where the representable step is about 7.6e-6, and that error travels through
  // the gradient into the slope. Tighter would be measuring IEEE 754.
  near("and the gap matches the lighting equation", nw - se, expectedGap, 1e-5);

  // The specific failure this guards: a sign error in the row gradient lights
  // the scene from the south east, and north and south swap.
  const north = centre(hillshade(facing(0), { exaggeration: 1 }));
  const south = centre(hillshade(facing(180), { exaggeration: 1 }));
  check("a north facing slope is lit more than a south facing one",
    north > south, `north ${north.toFixed(3)} vs south ${south.toFixed(3)}`);
  const east = centre(hillshade(facing(90), { exaggeration: 1 }));
  const west = centre(hillshade(facing(270), { exaggeration: 1 }));
  check("a west facing slope is lit more than an east facing one",
    west > east, `west ${west.toFixed(3)} vs east ${east.toFixed(3)}`);

  // Flat ground: shade is exactly cos(zenith), by definition.
  const flat = new Grid({
    width: 5, height: 5, cellSize: 1, originX: 0, originY: 5,
    data: new Float32Array(25).fill(50), nodata: -9999,
  });
  const flatShade = hillshade(flat, { altitude: 45 });
  // Float32, because the shade array is one: a double's worth of tolerance here
  // would only ever be measuring IEEE 754.
  near("flat ground shades to cos(zenith)", flatShade[12], Math.cos(45 * Math.PI / 180), 1e-6);
  check("flat ground shades uniformly",
    [...flatShade].every((s) => Math.abs(s - flatShade[12]) < 1e-9));

  // Exaggeration must strengthen relief, not shift it.
  const gentle = centre(hillshade(facing(315), { exaggeration: 1 }));
  const strong = centre(hillshade(facing(315), { exaggeration: 3 }));
  check("exaggeration deepens the effect", strong !== gentle, `${gentle.toFixed(3)} vs ${strong.toFixed(3)}`);

  const holed = new Grid({
    width: 5, height: 5, cellSize: 1, originX: 0, originY: 5,
    data: Float32Array.from({ length: 25 }, (_, i) => (i === 12 ? -9999 : 50)), nodata: -9999,
  });
  check("a nodata cell shades to nothing rather than to black",
    Number.isNaN(hillshade(holed)[12]));
}

console.log("\nRender: nodata is transparent, never the bottom of the ramp");
{
  const grid = new Grid({
    width: 4, height: 1, cellSize: 1, originX: 0, originY: 1,
    data: Float32Array.from([10, 20, -9999, 30]), nodata: -9999,
  });
  const rgba = renderGrid(grid, { stops: rampFor("rainbow"), min: 10, max: 30 });
  check("data pixels are opaque", rgba[3] === 255 && rgba[7] === 255 && rgba[15] === 255);
  check("the nodata pixel is fully transparent", rgba[11] === 0);
  check("and carries no colour at all",
    rgba[8] === 0 && rgba[9] === 0 && rgba[10] === 0,
    `${rgba[8]},${rgba[9]},${rgba[10]}`);
  check("the lowest value takes the bottom of the ramp",
    String([rgba[0], rgba[1], rgba[2]]) === String(sampleRamp(rampFor("rainbow"), 0)));
  check("the highest takes the top",
    String([rgba[12], rgba[13], rgba[14]]) === String(sampleRamp(rampFor("rainbow"), 1)));

  // Relief must shape the colour, not grey it out. A3's complaint about the old
  // render was exactly this.
  const relief = new Float32Array([1, 1, 1, 0]);
  const shaded = renderGrid(grid, { stops: rampFor("rainbow"), min: 10, max: 30, relief });
  check("fully lit ground is not darkened below its own colour",
    shaded[0] >= rgba[0] - 1, `${shaded[0]} vs ${rgba[0]}`);
  const deep = renderGrid(grid, {
    stops: rampFor("rainbow"), min: 10, max: 30, relief: new Float32Array([0, 0, 0, 0]),
  });
  check("deep shadow darkens but does not black out",
    deep[0] > 0 && deep[0] < rgba[0], `${deep[0]} vs ${rgba[0]}`);
}

console.log("\nTiles: the maths that decides where a pixel lands");
{
  // Round trip a known place. Kotba sits at roughly 73.7308 E, 20.8425 N.
  const z = 18;
  const lon = 73.73082;
  const lat = 20.84253;
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2) * n);

  const [west, south, east, north] = tileBoundsLonLat(z, x, y);
  check("the point falls inside the tile that claims it",
    lon >= west && lon <= east && lat >= south && lat <= north,
    `${west.toFixed(5)}..${east.toFixed(5)}, ${south.toFixed(5)}..${north.toFixed(5)}`);
  check("west is west of east and south is south of north", west < east && south < north);

  const [cLon, cLat] = tileLonLat(z, x, y, 0.5, 0.5, 1);
  check("the tile centre is inside its own bounds",
    cLon > west && cLon < east && cLat > south && cLat < north);

  // The projected bbox must contain every corner, and then some, because the
  // image of a Mercator tile in UTM is not a rectangle.
  const project = (lo, la) => lonLatToUtm(lo, la, 43, true);
  const [minX, minY, maxX, maxY] = tileBoundsProjected(z, x, y, project);
  for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0, 0.5]]) {
    const [plon, plat] = tileLonLat(z, x, y, px, py, 1);
    const [ex, ny] = project(plon, plat);
    check(`the projected bbox contains the tile edge at ${px},${py}`,
      ex >= minX - 1e-6 && ex <= maxX + 1e-6 && ny >= minY - 1e-6 && ny <= maxY + 1e-6);
  }

  check("a tile overlapping a raster is detected",
    overlaps([minX, minY, maxX, maxY], [minX - 10, minY - 10, maxX + 10, maxY + 10]));
  check("and one far away is not",
    !overlaps([minX, minY, maxX, maxY], [minX + 1e6, minY + 1e6, maxX + 1e6, maxY + 1e6]));

  // Ground resolution: at z18 a tile pixel is well under a metre near the
  // equator, and the value must shrink as zoom increases.
  const at18 = metresPerTilePixel(18, y);
  const at19 = metresPerTilePixel(19, y * 2);
  near("one zoom level halves the ground size of a pixel", at18 / at19, 2, 0.01);
  check("a pixel at z18 near the equator is sub metre", at18 < 1, `${at18.toFixed(3)} m`);
}

console.log("\nResampling a survey grid into a tile");
{
  // A synthetic grid in UTM 43N around Kotba, with a known linear surface, so
  // the resampled value at any point has a closed form.
  const originX = 367800;
  const originY = 2305400;
  const size = 64;
  const cellSize = 1;
  const data = new Float32Array(size * size);
  const value = (x, y) => 100 + (x - originX) * 0.01 + (originY - y) * 0.02;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      data[row * size + col] = value(originX + (col + 0.5) * cellSize, originY - (row + 0.5) * cellSize);
    }
  }
  const grid = new Grid({ width: size, height: size, cellSize, originX, originY, data, nodata: -9999, epsg: 32643 });

  const [lon, lat] = utmToLonLat(originX + 32, originY - 32, 43, true);
  const z = 20;
  const n = 2 ** z;
  const tx = Math.floor(((lon + 180) / 360) * n);
  const ty = Math.floor(((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2) * n);

  const project = (lo, la) => lonLatToUtm(lo, la, 43, true);
  const tile = sampleIntoTile(grid, z, tx, ty, project, 256);

  check("the tile has the shape asked for", tile.width === 256 && tile.height === 256);
  const withData = [...tile.data].filter((v) => !tile.isNoData(v));
  check("it carries data", withData.length > 0, `${withData.length} of ${tile.data.length} pixels`);

  // Every sampled value must satisfy the same linear law the grid was built
  // from. Bilinear interpolation is exact on a plane, so this is not a
  // tolerance, it is the definition.
  let worst = 0;
  for (let py = 0; py < 256; py += 17) {
    for (let px = 0; px < 256; px += 17) {
      const v = tile.data[py * 256 + px];
      if (tile.isNoData(v)) continue;
      const [plon, plat] = tileLonLat(z, tx, ty, px + 0.5, py + 0.5, 256);
      const [ex, ny] = project(plon, plat);
      worst = Math.max(worst, Math.abs(v - value(ex, ny)));
    }
  }
  near("every resampled pixel matches the analytic surface", worst, 0, 1e-4, " m");

  check("the tile reports its own ground resolution, not the raster's",
    Math.abs(tile.cellSize - metresPerTilePixel(z, ty, 256)) < 1e-9);

  // A tile far from the survey must be entirely nodata rather than edge values
  // smeared outward.
  const far = sampleIntoTile(grid, z, tx + 500, ty, project, 32);
  check("a tile away from the survey is entirely empty",
    [...far.data].every((v) => far.isNoData(v)));
}

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}\n`,
);
process.exit(failures ? 1 : 0);

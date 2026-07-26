/**
 * Guards the map pipeline against the shapes of data it will actually meet.
 *
 * Each case here was a real defect found by auditing the pipeline against data
 * types Sudaan produces but the Kotba demo happens not to contain. None of them
 * failed loudly: a -9999 nodata became terrain, a PolyLineZ contour file became
 * an empty layer, and an orthomosaic read as heights and reported "120 to 120 m".
 * Silence is the failure mode worth testing for.
 *
 * Run:
 *   node scripts/portal-map-test.mjs
 */
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("/tmp/rt", { recursive: true });
let pass=0, fail=0;
const check=(l,ok,d="")=>{console.log(`  ${ok?"ok  ":"FAIL"} ${l}${d?" — "+d:""}`); ok?pass++:fail++;};

// 1. nodata bound
const MIN=-500,MAX=9000, isElev=v=>Number.isFinite(v)&&v>MIN&&v<MAX;
for (const [v,want] of [[-9999,false],[-32767,false],[-32768,false],[-3.4028235e38,false],[NaN,false],[338,true],[-120,true],[8848,true]])
  check(`nodata: ${v} -> elevation=${isElev(v)}`, isElev(v)===want);

// 2. PolyLineZ is parsed. Build a minimal type 13 shapefile by hand.
function shpZ() {
  const pts=[[367800,2305200],[367850,2305250],[367900,2305300]];
  const n=pts.length;
  const content = 44 + 4 + n*16 + 16 + n*8 + 16 + n*8; // hdr+parts+xy+zrange+z+mrange+m
  const rec = Buffer.alloc(8+content);
  rec.writeInt32BE(1,0); rec.writeInt32BE(content/2,4);
  const b=8;
  rec.writeInt32LE(13,b);
  rec.writeDoubleLE(367800,b+4); rec.writeDoubleLE(2305200,b+12);
  rec.writeDoubleLE(367900,b+20); rec.writeDoubleLE(2305300,b+28);
  rec.writeInt32LE(1,b+36); rec.writeInt32LE(n,b+40);
  rec.writeInt32LE(0,b+44);
  let o=b+48;
  for(const [x,y] of pts){ rec.writeDoubleLE(x,o); rec.writeDoubleLE(y,o+8); o+=16; }
  rec.writeDoubleLE(300,o); rec.writeDoubleLE(302,o+8); o+=16;
  for(let i=0;i<n;i++){ rec.writeDoubleLE(300+i,o); o+=8; }
  rec.writeDoubleLE(0,o); rec.writeDoubleLE(0,o+8); o+=16;
  for(let i=0;i<n;i++){ rec.writeDoubleLE(0,o); o+=8; }
  const hdr=Buffer.alloc(100);
  hdr.writeInt32BE(9994,0); hdr.writeInt32BE((100+rec.length)/2,24);
  hdr.writeInt32LE(1000,28); hdr.writeInt32LE(13,32);
  return Buffer.concat([hdr,rec]);
}
writeFileSync("/tmp/rt/z.shp", shpZ());

const mod = await import("./lib/geo.mjs");
const shapes = mod.readShpPolylines("/tmp/rt/z.shp");
check("PolyLineZ (13) is parsed", shapes.length===1 && shapes[0] && shapes[0][0]?.length===3,
      JSON.stringify(shapes[0]?.[0]?.[0]));

// 3. RGB ortho must be refused, not misread
const orthoTif = await sharp({create:{width:32,height:32,channels:3,background:{r:120,g:90,b:60}}}).tiff().toBuffer();
writeFileSync("/tmp/rt/ortho.tif", orthoTif);
const m = await sharp("/tmp/rt/ortho.tif").metadata();
const refused = !(m.channels === 1 && m.depth === "float");
check("RGB ortho is detected as not-an-elevation-model", refused, `${m.channels}ch ${m.depth}`);


/* ------------------------------------------- manifest and background masking --- */

console.log("\n--- a partial run must not destroy the manifest ---");
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const { readManifest, emptyManifest, upsertLayer, writeManifest, verify } =
    await import("./lib/manifest.mjs");

  const dir = mkdtempSync(pathMod.join(tmpdir(), "manifest-"));
  const m = emptyManifest("test-site");
  upsertLayer(m, { key: "ortho", kind: "tiles", title: "Orthomosaic", tiles: "tiles/ortho/{z}/{x}/{y}.webp", minZoom: 1, maxZoom: 2 });
  upsertLayer(m, { key: "dtm", kind: "tiles", title: "Terrain model (DTM)", tiles: "tiles/dtm/{z}/{x}/{y}.webp", minZoom: 1, maxZoom: 2 });
  writeManifest(dir, m);

  // A second run that only produces one layer must upsert, not replace.
  const again = readManifest(dir);
  upsertLayer(again, { key: "ortho", kind: "tiles", title: "Orthomosaic", tiles: "tiles/ortho/{z}/{x}/{y}.webp", minZoom: 1, maxZoom: 3 });
  writeManifest(dir, again);
  const after = readManifest(dir);
  check("re-running for one layer keeps the others", after.layers.length === 2,
    after.layers.map((l) => l.key).join(", "));
  check("and updates the one it produced rather than duplicating it",
    after.layers.filter((l) => l.key === "ortho").length === 1 &&
      after.layers.find((l) => l.key === "ortho").maxZoom === 3);

  // verify() must notice a layer whose tiles are not there.
  for (const z of [1, 2]) mkdirSync(pathMod.join(dir, "tiles", "ortho", String(z), "0"), { recursive: true });
  writeFileSync(pathMod.join(dir, "tiles", "ortho", "1", "0", "0.webp"), "x");
  const problems = verify(dir);
  check("verify() reports a layer with no tiles on disk",
    problems.some((p) => /dtm/.test(p)), problems.find((p) => /dtm/.test(p)) ?? "none");
  check("verify() reports a zoom range that disagrees with disk",
    problems.some((p) => /z1-3|disk has/.test(p)), problems.find((p) => /disk has/.test(p)) ?? "none");
}

console.log("\n--- flat filler around a footprint becomes transparent ---");
{
  const { detectBackground, maskBorderBackground } = await import("./lib/nodata.mjs");
  const W = 40, H = 40;
  const rgba = Buffer.alloc(W * H * 4);
  // White frame, green blob in the middle, plus one white pixel inside the blob.
  for (let i = 0; i < W * H; i += 1) {
    const x = i % W, y = (i / W) | 0;
    const inside = x > 9 && x < 30 && y > 9 && y < 30;
    const v = inside ? [90, 140, 70] : [255, 255, 255];
    rgba[i * 4] = v[0]; rgba[i * 4 + 1] = v[1]; rgba[i * 4 + 2] = v[2]; rgba[i * 4 + 3] = 255;
  }
  const roof = (20 * W + 20) * 4;
  rgba[roof] = 255; rgba[roof + 1] = 255; rgba[roof + 2] = 255;

  check("the filler colour is detected from the corners",
    JSON.stringify(detectBackground(rgba, W, H)) === JSON.stringify([255, 255, 255]));
  const res = maskBorderBackground(rgba, W, H);
  check("the border filler is cleared", res !== null && res.cleared > 0, res ? `${(res.share * 100).toFixed(0)}% cleared` : "nothing");
  check("a white roof inside the footprint is NOT cleared", rgba[roof + 3] === 255,
    "otherwise the mask punches holes through real imagery");
  check("a corner really is transparent now", rgba[3] === 0);

  // Imagery that fills its own frame must be left alone.
  const full = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    full[i * 4] = 90; full[i * 4 + 1] = 140; full[i * 4 + 2] = 70; full[i * 4 + 3] = 255;
  }
  check("imagery with no flat border is left untouched", maskBorderBackground(full, W, H) === null);
}

console.log(`\n${fail === 0 ? `all ${pass} checks passed` : `${pass} passed, ${fail} FAILED`}`);
process.exit(fail ? 1 : 0);

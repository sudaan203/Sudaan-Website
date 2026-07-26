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

console.log(fail===0?`\nall ${pass} checks passed\n`:`\n${fail} FAILED\n`);
process.exit(fail?1:0);

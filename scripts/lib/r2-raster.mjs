/**
 * Read a survey's raster straight out of R2, windowed, without downloading it.
 *
 * ## Why this exists
 *
 * The precomputes a published site needs — the spill surface, the hypsometric
 * table — are built from the DTM, and the two surveys that need them most are
 * a 1.9 GB and a 2.1 GB file. Keeping those on the machine that runs the
 * pipeline is a 29 GB standing cost for data that is *already* in R2, byte for
 * byte, because that is where the portal serves it from.
 *
 * So the pipeline reads the same bytes the portal reads. Nothing has to be
 * downloaded first, nothing has to be kept, and a laptop with four gigabytes
 * free can publish a survey it could not store.
 *
 * ## Range reads against SigV4, and the one surprising part
 *
 * `httpSource` already does everything needed — banded reads, chunk
 * coalescing, the 200-instead-of-206 guard — and takes its headers as a
 * *function* precisely so a short-lived credential can be refreshed per
 * request. That was written for the tile Worker's thirty-minute grant; a SigV4
 * signature has the same shape, since it is stamped with the current time and
 * goes stale.
 *
 * The surprising part is that `Range` is **not signed**. SigV4 signs the
 * headers it names in `SignedHeaders`, and R2 accepts additional unsigned ones,
 * so one signature per request works with whatever range that request needs.
 * Verified against Kiru's 2.3 GB DTM: 206, `content-range bytes 0-1023/2305451574`,
 * and a valid BigTIFF header at offset zero.
 *
 * If that ever stopped being true the failure would be loud rather than subtle:
 * R2 would answer 403, or answer 200 with the whole object, and `httpSource`
 * refuses a 200 to a range request outright rather than reading the wrong bytes
 * out of it.
 */

import { httpSource } from "../../src/lib/geo/raster-source.mjs";
import { r2Client, r2Credentials } from "./r2.mjs";

/**
 * A raster source over one R2 object.
 *
 * @param {string} key object key, e.g. `sites/kiru-hydroelectric-survey/dtm.tif`
 * @param {{ client?: ReturnType<typeof r2Client> }} [options]
 */
export function r2RasterSource(key, { client = r2Client(r2Credentials()) } = {}) {
  const { url } = client.sign({ method: "GET", key });
  return httpSource(url, {
    /*
     * Re-signed per request rather than once. A signature carries the time it
     * was made and R2 rejects one that has drifted, and an opened raster is
     * held for the life of the process — so a signature captured at open would
     * work for a few minutes and then start failing partway through a long
     * banded pass, which is the worst moment to discover it.
     */
    headers: () => client.sign({ method: "GET", key }).headers,
  });
}

/** The conventional key for a survey's raster, matching what `upload-site` writes. */
export function terrainKey(slug, kind = "dtm") {
  return `sites/${slug}/${kind}.tif`;
}

/**
 * Open a survey's raster from R2, or from disk when it is there.
 *
 * Local first, deliberately. A file already on the machine is faster and free,
 * and a pipeline run on the workstation that produced the survey should not
 * make thousands of range requests for bytes sitting next to it. R2 is the
 * fallback that makes the local copy *optional* rather than required.
 */
export async function openTerrainSource(slug, kind, { localPath = null } = {}) {
  const { existsSync } = await import("node:fs");
  const { cached, fileSource } = await import("../../src/lib/geo/raster-source.mjs");
  if (localPath && existsSync(localPath)) {
    return { source: cached(await fileSource(localPath)), from: localPath };
  }
  return { source: cached(r2RasterSource(terrainKey(slug, kind))), from: `r2:${terrainKey(slug, kind)}` };
}

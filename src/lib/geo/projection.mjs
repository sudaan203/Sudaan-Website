/**
 * UTM to WGS84 and back, the one projection this pipeline handles.
 *
 * Lives under src/lib/geo because it is product code now, not build tooling.
 * The portal's analysis routes need it to turn a polygon drawn on a web map into
 * the projected metres every area and volume must be computed in, and
 * scripts/lib/geo.mjs re-exports it so the existing map pipeline is untouched.
 *
 * Written out rather than pulling in proj4: the .prj files confirm every input
 * is UTM on WGS84, and a dependency here would be carried by the Next bundle.
 */


/**
 * Inverse UTM to WGS84. Standard series expansion, accurate to millimetres over
 * a zone, which is far beyond what a survey overlay needs.
 *
 * Written out rather than pulling in proj4: this is the only projection the
 * pipeline handles, and the .prj files confirm every input is UTM 43N on WGS84.
 */
function utmToLonLat(easting, northing, zone, northern = true) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);

  const x = easting - 500000;
  const y = northern ? northing : northing - 10000000;

  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const n1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const t1 = tanPhi1 * tanPhi1;
  const c1 = ep2 * cosPhi1 * cosPhi1;
  const r1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const d = x / (n1 * k0);

  const lat =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);

  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
    cosPhi1;

  const lonOrigin = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  return [((lon + lonOrigin) * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** Forward UTM, the direction prepare-map-data.mjs does not need. */
function lonLatToUtm(lon, lat, zone, northern = true) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);

  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;

  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lambda - lambda0);

  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));

  const easting =
    k0 * n * (A + ((1 - t + c) * A ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * A ** 5) / 120) +
    500000;

  let northing =
    k0 *
    (m +
      n *
        Math.tan(phi) *
        ((A * A) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * A ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * A ** 6) / 720));
  if (!northern) northing += 10000000;

  return [easting, northing];
}

export { utmToLonLat, lonLatToUtm };

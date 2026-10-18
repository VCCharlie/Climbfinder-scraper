/**
 * Uniform grid spatial index for climb bbox pre-filtering (O(cells) query vs O(all climbs)).
 * Bbox format from climb JSON: [minLon, minLat, maxLon, maxLat].
 */

const { bboxFromCoords, climbCoordsLonLat, expandBBoxM, bboxesOverlapM } = require("./climbMatch");

const DEFAULT_CELL_DEG = 0.018; // ~2 km latitude

function climbBBoxLatLon(climb) {
  const b = climb?.bbox;
  if (Array.isArray(b) && b.length >= 4) {
    const [minLon, minLat, maxLon, maxLat] = b.map(Number);
    if ([minLon, minLat, maxLon, maxLat].every((n) => Number.isFinite(n))) {
      return { minLat, maxLat, minLon, maxLon };
    }
  }
  const coords = climbCoordsLonLat(climb);
  return bboxFromCoords(coords);
}

function cellKeyForLatLon(lat, lon, cellDeg) {
  const ci = Math.floor(lat / cellDeg);
  const cj = Math.floor(lon / cellDeg);
  return `${ci}:${cj}`;
}

function cellsForBBox(box, cellDeg, padM) {
  const expanded = padM > 0 ? expandBBoxM(box, padM) : box;
  if (!expanded) return [];
  const keys = new Set();
  const minCi = Math.floor(expanded.minLat / cellDeg);
  const maxCi = Math.floor(expanded.maxLat / cellDeg);
  const minCj = Math.floor(expanded.minLon / cellDeg);
  const maxCj = Math.floor(expanded.maxLon / cellDeg);
  for (let ci = minCi; ci <= maxCi; ci += 1) {
    for (let cj = minCj; cj <= maxCj; cj += 1) {
      keys.add(`${ci}:${cj}`);
    }
  }
  return keys;
}

/**
 * @param {object[]} climbs
 * @param {{ cellDeg?: number }} [opts]
 */
function buildClimbSpatialIndex(climbs, opts = {}) {
  const cellDeg = opts.cellDeg ?? DEFAULT_CELL_DEG;
  /** @type {Map<string, object[]>} */
  const grid = new Map();
  /** @type {Map<string, object>} */
  const byId = new Map();

  for (const climb of climbs || []) {
    const id = climb.id || climb.name;
    if (id) byId.set(String(id), climb);
    const box = climbBBoxLatLon(climb);
    if (!box) continue;
    for (const key of cellsForBBox(box, cellDeg, 0)) {
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(climb);
    }
  }

  return {
    cellDeg,
    grid,
    byId,
    climbCount: (climbs || []).length,
  };
}

/**
 * @param {ReturnType<typeof buildClimbSpatialIndex>} index
 * @param {object} trackBox — lat/lon bbox
 * @param {number} padM
 */
function queryClimbsInTrackBox(index, trackBox, padM) {
  if (!index || !trackBox) return [];
  const keys = cellsForBBox(trackBox, index.cellDeg, padM);
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const bucket = index.grid.get(key);
    if (!bucket) continue;
    for (const climb of bucket) {
      const id = climb.id || climb.name || climb;
      const sid = String(id);
      if (seen.has(sid)) continue;
      const climbBox = climbBBoxLatLon(climb);
      if (!bboxesOverlapM(climbBox, trackBox, padM)) continue;
      seen.add(sid);
      out.push(climb);
    }
  }
  return out;
}

module.exports = {
  DEFAULT_CELL_DEG,
  climbBBoxLatLon,
  buildClimbSpatialIndex,
  queryClimbsInTrackBox,
  cellsForBBox,
};

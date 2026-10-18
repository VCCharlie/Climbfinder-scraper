/**
 * Map activity GPS to Climbfinder region datasets via locality centroids (not country alone).
 */
const { decodePolyline, bboxFromCoords } = require("./climbMatch");

const EARTH_R = 6371000;

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)))) / 1000;
}

/**
 * @param {object} indexJson — climbs/data/index.json
 * @param {object} geoJson — climbs/data/climbfinder-regions-geo.json
 */
function buildRegionDatasetRouter(indexJson, geoJson) {
  const centroids = geoJson?.regions || {};
  /** @type {{ datasetId: string, lat: number, lon: number, country: string }[]} */
  const entries = [];
  for (const r of indexJson?.regions || []) {
    const datasetId = String(r.id || "").trim();
    const locId = r.locality_id != null ? String(r.locality_id) : null;
    if (!datasetId || !locId) continue;
    const c = centroids[locId];
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    entries.push({
      datasetId,
      lat: c.lat,
      lon: c.lon,
      country: String(r.country || c.country_iso || "").toUpperCase(),
    });
  }

  return {
    entries,
    defaultRadiusKm: 95,
    maxDatasetsPerActivity: 10,
  };
}

function trackCentroidLatLon(encodedPolyline) {
  const track = decodePolyline(encodedPolyline);
  if (track.length < 2) return null;
  const box = bboxFromCoords(track);
  if (!box) return null;
  return { lat: (box.minLat + box.maxLat) / 2, lon: (box.minLon + box.maxLon) / 2 };
}

/**
 * Dataset ids from candidate list that are near the ride (centroid distance).
 * @param {ReturnType<typeof buildRegionDatasetRouter>} router
 * @param {string} encodedPolyline
 * @param {string[]} candidateDatasetIds
 */
function filterDatasetIdsNearPolyline(router, encodedPolyline, candidateDatasetIds, opts = {}) {
  const radiusKm = opts.radiusKm ?? router.defaultRadiusKm;
  const maxDs = opts.maxDatasets ?? router.maxDatasetsPerActivity;
  const center = trackCentroidLatLon(encodedPolyline);
  if (!center || !router.entries.length) return candidateDatasetIds;

  const allow = new Set(candidateDatasetIds.map(String));
  const scored = [];
  for (const e of router.entries) {
    if (!allow.has(e.datasetId)) continue;
    const dKm = haversineKm(center.lat, center.lon, e.lat, e.lon);
    if (dKm <= radiusKm) scored.push({ datasetId: e.datasetId, dKm });
  }
  scored.sort((a, b) => a.dKm - b.dKm);
  if (!scored.length) {
    return candidateDatasetIds.slice(0, Math.min(3, candidateDatasetIds.length));
  }
  return scored.slice(0, maxDs).map((s) => s.datasetId);
}

function activityLikelyInDataset(router, datasetId, encodedPolyline, opts = {}) {
  const radiusKm = opts.radiusKm ?? router.defaultRadiusKm;
  const center = trackCentroidLatLon(encodedPolyline);
  if (!center) return true;
  const entry = router.entries.find((e) => e.datasetId === datasetId);
  if (!entry) return true;
  return haversineKm(center.lat, center.lon, entry.lat, entry.lon) <= radiusKm * 1.15;
}

let cachedRouter = null;

async function loadRegionDatasetRouter(fetchDataJson) {
  if (cachedRouter) return cachedRouter;
  const [index, geo] = await Promise.all([
    fetchDataJson("index.json"),
    fetchDataJson("climbfinder-regions-geo.json"),
  ]);
  cachedRouter = buildRegionDatasetRouter(index, geo);
  return cachedRouter;
}

module.exports = {
  buildRegionDatasetRouter,
  filterDatasetIdsNearPolyline,
  activityLikelyInDataset,
  loadRegionDatasetRouter,
  trackCentroidLatLon,
};

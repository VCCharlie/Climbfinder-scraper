/**
 * Gradient / steepest helpers for climb JSON (mirrors scripts/climbfinder_import.py).
 */
(function (global) {
  function segmentGradients(distances_m, elevations_m) {
    const out = [0];
    for (let i = 1; i < elevations_m.length; i++) {
      const d = distances_m[i] - distances_m[i - 1];
      out.push(d > 0 ? (100 * (elevations_m[i] - elevations_m[i - 1])) / d : 0);
    }
    return out;
  }

  /** Max average gradient over any contiguous window of window_m metres. */
  function steepestGradientPct(distances_m, elevations_m, window_m) {
    const n = distances_m.length;
    let best = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = distances_m[j] - distances_m[i];
        if (d < window_m) continue;
        const g = (100 * (elevations_m[j] - elevations_m[i])) / d;
        if (g > best) best = g;
        break;
      }
    }
    return Math.round(best * 10) / 10;
  }

  function interpolateGraphGradients(graphDistances_m, graphGradients_pct, pathDistances_m) {
    if (!graphDistances_m?.length || !graphGradients_pct?.length) return null;
    return pathDistances_m.map((d) => {
      if (d <= graphDistances_m[0]) return graphGradients_pct[0];
      for (let i = 1; i < graphDistances_m.length; i++) {
        if (d <= graphDistances_m[i]) {
          const d0 = graphDistances_m[i - 1];
          const d1 = graphDistances_m[i];
          const t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
          return graphGradients_pct[i - 1] * (1 - t) + graphGradients_pct[i] * t;
        }
      }
      return graphGradients_pct[graphGradients_pct.length - 1];
    });
  }

  function gradientsForClimb(climb) {
    const p = climb.profile || {};
    const dist = p.distances_m;
    const elev = p.elevations_m;
    if (!dist?.length || !elev?.length) return [];
    if (p.gradients_pct?.length === dist.length) return p.gradients_pct;
    const fromGraph = interpolateGraphGradients(p.graph_distances_m, p.graph_gradients_pct, dist);
    if (fromGraph) return fromGraph;
    return segmentGradients(dist, elev);
  }

  /** Climbfinder-like ramp colours (filled profile blocks). */
  function gradientColor(pct) {
    const g = pct ?? 0;
    if (g < 0) return "#b8c9d9";
    if (g <= 3) return "#fde68a";
    if (g <= 6) return "#fdba74";
    if (g <= 9) return "#fb923c";
    if (g <= 12) return "#f87171";
    if (g <= 16) return "#dc2626";
    return "#7f1d1d";
  }

  /** Long climbs: 1 km blocks; shorter: 500 m (≤ 2 km: 100 m like Climbfinder detail). */
  function profileBucketSizeM(length_m, thresholdKm = 5) {
    const len = length_m || 0;
    if (len > thresholdKm * 1000) return 1000;
    if (len > 2000) return 500;
    return 100;
  }

  function elevationAtM(distances_m, elevations_m, targetM) {
    if (!distances_m.length) return 0;
    if (targetM <= distances_m[0]) return elevations_m[0];
    const last = distances_m.length - 1;
    if (targetM >= distances_m[last]) return elevations_m[last];
    for (let i = 1; i < distances_m.length; i++) {
      if (targetM <= distances_m[i]) {
        const d0 = distances_m[i - 1];
        const d1 = distances_m[i];
        const t = d1 > d0 ? (targetM - d0) / (d1 - d0) : 0;
        return elevations_m[i - 1] * (1 - t) + elevations_m[i] * t;
      }
    }
    return elevations_m[last];
  }

  function averageGradientPct(distances_m, elevations_m, startM, endM) {
    const span = endM - startM;
    if (span <= 0) return 0;
    const e0 = elevationAtM(distances_m, elevations_m, startM);
    const e1 = elevationAtM(distances_m, elevations_m, endM);
    return Math.round(((100 * (e1 - e0)) / span) * 10) / 10;
  }

  /** Map distance along climb (m) to index in geometry.coordinates. */
  function geometryIndexForDistanceM(climb, targetM) {
    const dist = climb.profile?.distances_m;
    const coords = climb.geometry?.coordinates;
    if (!dist?.length || !coords?.length) return 0;
    if (targetM <= dist[0]) return 0;
    const last = dist.length - 1;
    if (targetM >= dist[last]) return coords.length - 1;
    for (let i = 1; i < dist.length; i++) {
      if (targetM <= dist[i]) {
        const d0 = dist[i - 1];
        const d1 = dist[i];
        const t = d1 > d0 ? (targetM - d0) / (d1 - d0) : 0;
        const g0 = Math.min(i - 1, coords.length - 1);
        const g1 = Math.min(i, coords.length - 1);
        return Math.min(coords.length - 1, Math.max(0, Math.round(g0 * (1 - t) + g1 * t)));
      }
    }
    return coords.length - 1;
  }

  /** Lat/lng pairs [lat,lng] for a distance range on the route (Leaflet order). */
  function latLngSliceForDistanceRange(climb, startM, endM) {
    const coords = climb.geometry?.coordinates;
    if (!coords?.length) return [];
    const i0 = geometryIndexForDistanceM(climb, startM);
    const i1 = geometryIndexForDistanceM(climb, endM);
    const a = Math.min(i0, i1);
    const b = Math.max(i0, i1);
    return coords.slice(a, b + 1).map(([lng, lat]) => [lat, lng]);
  }

  /** Coloured route segments aligned with profileBuckets (Climbfinder-style map line). */
  function routeGradientSegments(climb, thresholdKm = 5) {
    const buckets = profileBuckets(climb, thresholdKm);
    if (!buckets.length) return [];
    return buckets
      .map((b) => ({
        color: b.color,
        label: b.label,
        gradientPct: b.gradientPct,
        startM: b.startM,
        endM: b.endM,
        latlngs: latLngSliceForDistanceRange(climb, b.startM, b.endM),
      }))
      .filter((s) => s.latlngs.length >= 2);
  }

  function profileBuckets(climb, thresholdKm = 5) {
    const p = climb.profile || {};
    const dist = p.distances_m;
    const elev = p.elevations_m;
    if (!dist?.length || !elev?.length) return [];
    const totalM = dist[dist.length - 1] || climb.stats?.length_m || 0;
    const step = profileBucketSizeM(totalM, thresholdKm);
    const buckets = [];
    for (let start = 0; start < totalM - 0.01; start += step) {
      const end = Math.min(start + step, totalM);
      const gradientPct = averageGradientPct(dist, elev, start, end);
      buckets.push({
        startM: start,
        endM: end,
        startKm: start / 1000,
        endKm: end / 1000,
        gradientPct,
        color: gradientColor(gradientPct),
        label: String(Math.round(gradientPct)),
      });
    }
    return buckets;
  }

  function sliceProfilePoints(distances_m, elevations_m, startM, endM) {
    const pts = [{ x: startM / 1000, y: elevationAtM(distances_m, elevations_m, startM) }];
    for (let i = 0; i < distances_m.length; i++) {
      const d = distances_m[i];
      if (d > startM && d < endM) pts.push({ x: d / 1000, y: elevations_m[i] });
    }
    const endPt = { x: endM / 1000, y: elevationAtM(distances_m, elevations_m, endM) };
    if (pts[pts.length - 1].x < endPt.x - 1e-6) pts.push(endPt);
    else pts[pts.length - 1] = endPt;
    return pts;
  }

  /** Filled vertical bands under the elevation line (Climbfinder-style). */
  const profileFillPlugin = {
    id: "fietsklimProfileFill",
    beforeDatasetsDraw(chart) {
      const buckets = chart.config.options?.plugins?.fietsklimProfileFill?.buckets;
      const profile = chart.config.options?.plugins?.fietsklimProfileFill?.profile;
      if (!buckets?.length || !profile?.distances_m) return;

      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      const yScale = scales.y;
      const bottom = chartArea.bottom;
      const { distances_m, elevations_m } = profile;

      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
      ctx.clip();

      for (const b of buckets) {
        const slice = sliceProfilePoints(distances_m, elevations_m, b.startM, b.endM);
        if (slice.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(xScale.getPixelForValue(slice[0].x), bottom);
        for (const pt of slice) {
          ctx.lineTo(xScale.getPixelForValue(pt.x), yScale.getPixelForValue(pt.y));
        }
        ctx.lineTo(xScale.getPixelForValue(slice[slice.length - 1].x), bottom);
        ctx.closePath();
        ctx.fillStyle = b.color;
        ctx.fill();
      }

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1;
      for (let i = 1; i < buckets.length; i++) {
        const x = xScale.getPixelForValue(buckets[i].startKm);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }

      ctx.font = "700 11px Barlow, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const b of buckets) {
        const midKm = (b.startKm + b.endKm) / 2;
        const px = xScale.getPixelForValue(midKm);
        const x0 = xScale.getPixelForValue(b.startKm);
        const x1 = xScale.getPixelForValue(b.endKm);
        if (x1 - x0 < 10) continue;
        const midElev = elevationAtM(distances_m, elevations_m, (b.startM + b.endM) / 2);
        const topY = yScale.getPixelForValue(midElev);
        const py = Math.min(bottom - 12, Math.max(chartArea.top + 10, (topY + bottom) / 2));
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillText(b.label, px, py);
      }

      ctx.restore();
    },
  };

  /** Climbfinder category: HC, SHC, 1–5 (Alpine / UCI-style). */
  function climbCategory(climb) {
    const raw =
      climb?.classification ??
      climb?.climbfinder?.category ??
      (climb?.difficulty_score != null && Number.isFinite(climb.difficulty_score)
        ? String(Math.round(climb.difficulty_score))
        : "");
    const c = String(raw || "")
      .trim()
      .toUpperCase();
    if (!c) return null;
    if (c === "HC" || c === "SHC") return c;
    if (/^[1-5]$/.test(c)) return c;
    return c.length <= 4 ? c : null;
  }

  function categoryDescription(cat) {
    const map = {
      HC: "Hors catégorie",
      SHC: "Super hors catégorie",
      "1": "1e categorie",
      "2": "2e categorie",
      "3": "3e categorie",
      "4": "4e categorie",
      "5": "5e categorie",
    };
    return map[cat] || `Categorie ${cat}`;
  }

  function categoryBadgeClass(cat) {
    if (cat === "HC") return "cat-hc";
    if (cat === "SHC") return "cat-shc";
    if (cat === "1") return "cat-1";
    if (cat === "2") return "cat-2";
    if (cat === "3") return "cat-3";
    if (cat === "4") return "cat-4";
    if (cat === "5") return "cat-5";
    return "cat-unknown";
  }

  function categoryBadgeHtml(climb, size = "md") {
    const cat = climbCategory(climb);
    if (!cat) return "";
    const sz = size === "sm" ? " climb-cat-badge--sm" : "";
    return `<span class="climb-cat-badge ${categoryBadgeClass(cat)}${sz}" title="${categoryDescription(cat)}">${cat}</span>`;
  }

  /** Climbfinder difficulty points (bolt score on map), when imported from climb page. */
  function climbLightningScore(climb) {
    const raw =
      climb?.climbfinder?.difficulty_points ??
      climb?.stats?.difficulty_points ??
      climb?.difficulty_points;
    if (raw == null || !Number.isFinite(Number(raw))) return null;
    const n = Number(raw);
    return n > 0 ? n : null;
  }

  /** Numeric Climbfinder category when present (1–5); HC/SHC stay categorical. */
  function climbDifficultyScore(climb) {
    if (climb?.difficulty_score != null && Number.isFinite(climb.difficulty_score)) {
      return climb.difficulty_score;
    }
    const cat = climbCategory(climb);
    if (cat && /^[1-5]$/.test(cat)) return Number(cat);
    return null;
  }

  /** Lightning tier keys (Climbfinder map legend: &lt;4, 4+, 8+, 12+, 34+). */
  function lightningTierKeyFromScore(score) {
    const s = Math.round(score);
    if (s < 4) return "L0";
    if (s < 8) return "L4";
    if (s < 12) return "L8";
    if (s < 34) return "L12";
    return "L34";
  }

  /** Fallback zwaarte-proxy from average gradient when import lacks category. */
  function difficultyProxyFromGradient(climb) {
    const g = climb?.stats?.avg_gradient_pct;
    if (g == null || !Number.isFinite(g)) return null;
    if (g < 4) return 5;
    if (g < 6) return 4;
    if (g < 8) return 3;
    if (g < 10) return 2;
    return 1;
  }

  function difficultyTierKey(climb) {
    const lightning = climbLightningScore(climb);
    if (lightning != null) return lightningTierKeyFromScore(lightning);
    const cat = climbCategory(climb);
    if (cat === "HC" || cat === "SHC") return cat;
    const score = climbDifficultyScore(climb);
    if (score != null) {
      const n = Math.max(1, Math.min(5, Math.round(score)));
      return String(n);
    }
    const proxy = difficultyProxyFromGradient(climb);
    return proxy != null ? String(proxy) : "unknown";
  }

  const LIGHTNING_MAP_COLORS = {
    L0: { fill: "#22c55e", stroke: "#15803d", label: "< 4" },
    L4: { fill: "#eab308", stroke: "#a16207", label: "4+" },
    L8: { fill: "#fb923c", stroke: "#c2410c", label: "8+" },
    L12: { fill: "#ef4444", stroke: "#b91c1c", label: "12+" },
    L34: { fill: "#a855f7", stroke: "#6b21a8", label: "34+" },
  };

  const DIFFICULTY_MAP_COLORS = {
    ...LIGHTNING_MAP_COLORS,
    5: { fill: "#22c55e", stroke: "#15803d", label: "Cat. 5" },
    4: { fill: "#eab308", stroke: "#a16207", label: "Cat. 4" },
    3: { fill: "#fb923c", stroke: "#c2410c", label: "Cat. 3" },
    2: { fill: "#f97316", stroke: "#ea580c", label: "Cat. 2" },
    1: { fill: "#ef4444", stroke: "#b91c1c", label: "Cat. 1" },
    HC: { fill: "#c084fc", stroke: "#7e22ce", label: "HC" },
    SHC: { fill: "#7e22ce", stroke: "#581c87", label: "SHC" },
    unknown: { fill: "#cbd5e1", stroke: "#64748b", label: "Onbekend" },
  };

  function difficultyMapColors(climb) {
    const key = difficultyTierKey(climb);
    return DIFFICULTY_MAP_COLORS[key] || DIFFICULTY_MAP_COLORS.unknown;
  }

  /** Short label on map markers when zoomed in (Climbfinder-style). */
  function difficultyMarkerLabel(climb) {
    const lightning = climbLightningScore(climb);
    if (lightning != null) return String(Math.round(lightning));
    const cat = climbCategory(climb);
    if (cat) return cat;
    const score = climbDifficultyScore(climb);
    if (score != null) return String(Math.round(score));
    const proxy = difficultyProxyFromGradient(climb);
    return proxy != null ? String(proxy) : "";
  }

  function difficultyLegendTiers() {
    return ["L0", "L4", "L8", "L12", "L34", "5", "4", "3", "2", "1", "HC", "SHC", "unknown"];
  }

  function difficultyLegendTitle(entries) {
    if (!entries?.length) return "Zwaarte";
    const anyLightning = entries.some((c) => climbLightningScore(c) != null);
    const anyCategory = entries.some((c) => climbLightningScore(c) == null && difficultyTierKey(c) !== "unknown");
    if (anyLightning && !anyCategory) return "Moeilijkheidspunten";
    if (anyLightning && anyCategory) return "Zwaarte / punten";
    return "Zwaarte";
  }

  global.ClimbMetrics = {
    segmentGradients,
    steepestGradientPct,
    interpolateGraphGradients,
    gradientsForClimb,
    gradientColor,
    profileBucketSizeM,
    elevationAtM,
    averageGradientPct,
    profileBuckets,
    geometryIndexForDistanceM,
    latLngSliceForDistanceRange,
    routeGradientSegments,
    sliceProfilePoints,
    profileFillPlugin,
    climbCategory,
    categoryDescription,
    categoryBadgeHtml,
    climbLightningScore,
    climbDifficultyScore,
    lightningTierKeyFromScore,
    difficultyProxyFromGradient,
    difficultyTierKey,
    difficultyMapColors,
    difficultyMarkerLabel,
    difficultyLegendTiers,
    difficultyLegendTitle,
    LIGHTNING_MAP_COLORS,
    DIFFICULTY_MAP_COLORS,
  };
})(typeof window !== "undefined" ? window : globalThis);

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

  function gradientColor(pct) {
    const g = pct ?? 0;
    if (g >= 12) return "#b91c1c";
    if (g >= 9) return "#ea580c";
    if (g >= 6) return "#d97706";
    if (g >= 3) return "#65a30d";
    return "#0d9488";
  }

  global.ClimbMetrics = {
    segmentGradients,
    steepestGradientPct,
    interpolateGraphGradients,
    gradientsForClimb,
    gradientColor,
  };
})(typeof window !== "undefined" ? window : globalThis);

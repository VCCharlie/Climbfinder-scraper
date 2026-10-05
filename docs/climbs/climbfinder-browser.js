/**
 * Climbfinder climb page → JSON (browser, via CORS proxy).
 * Popular ranking slugs: prebuilt under data/rankings/{locality}-popular-slugs.json
 * (refresh: python scripts/refresh_ranking_slugs.py --locality ID)
 */
(function (global) {
  const CORS_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  ];

  function cfDecode(b64, scale, seed) {
    const bin = atob(b64);
    const n = bin.length;
    let s = (((seed | 0) ^ 0x5eedc11b) ^ (Math.imul(n, 2654435761) >>> 0)) >>> 0;
    if (!s) s = 0x1f2e3d4c;
    const bytes = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      bytes[k] = bin.charCodeAt(k) ^ (s & 0xff);
    }
    const out = [];
    let prev = 0;
    let i = 0;
    while (i < n) {
      let z = 0;
      let shift = 0;
      let b;
      do {
        b = bytes[i++];
        z += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      if (z % 2 === 1) prev += -((z + 1) / 2);
      else prev += z / 2;
      out.push(prev / scale);
    }
    return out;
  }

  function extractCoordinatesArray(text) {
    const marker = '"coordinates":';
    const start = text.indexOf(marker);
    if (start < 0) throw new Error("Geen polyline in pagina");
    const i = text.indexOf("[", start);
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "[") depth++;
      else if (text[j] === "]") {
        depth--;
        if (depth === 0) return JSON.parse(text.slice(i, j + 1));
      }
    }
    throw new Error("Polyline JSON onleesbaar");
  }

  async function fetchHtml(url) {
    let lastErr;
    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy(url));
        if (!res.ok) continue;
        const text = await res.text();
        if (text.includes("pathElevationsEnc") || text.includes("climbgeojson")) return text;
      } catch (e) {
        lastErr = e;
      }
    }
    const msg =
      lastErr?.message ||
      "Kon Climbfinder-pagina niet ophalen (CORS/proxy). Gebruik lokaal: python scripts/climbfinder_import.py --locality …";
    throw new Error(msg);
  }

  function parseDifficulty(category) {
    if (!category) return null;
    const n = parseFloat(category);
    return Number.isFinite(n) ? n : null;
  }

  function parseClimbPage(pageHtml, slug, regionLabel, country, tags) {
    const idM = pageHtml.match(/climbId\s*=\s*(\d+)/);
    const dataM = pageHtml.match(
      /const DATA = \{\s*name:\s*"([^"]*)",\s*category:\s*"([^"]*)",\s*sd:\s*(\d+),\s*graphInterval:\s*(\d+),\s*graphGradientsEnc:\s*"([^"]+)",\s*pathInterval:\s*(\d+),\s*pathElevationsEnc:\s*"([^"]+)",\s*length:\s*(\d+)/
    );
    if (!dataM) throw new Error("Geen profieldata (DATA) op pagina");

    const geoStart = pageHtml.indexOf("const climbgeojson");
    const geoEnd = pageHtml.indexOf("const finishgeojson", geoStart);
    const geoChunk = geoStart >= 0 && geoEnd > geoStart ? pageHtml.slice(geoStart, geoEnd) : pageHtml;
    const coordinates = extractCoordinatesArray(geoChunk);

    const name = dataM[1].replace(/&#039;/g, "'").replace(/&amp;/g, "&");
    const category = dataM[2];
    const sd = parseInt(dataM[3], 10);
    const graphInterval = parseInt(dataM[4], 10);
    const gradEnc = dataM[5];
    const pathInterval = parseInt(dataM[6], 10);
    const lengthM = parseInt(dataM[8], 10);
    const elevations = cfDecode(dataM[7], 10, sd);
    const distances = elevations.map((_, i) => Math.min(i * pathInterval, lengthM));

    const graphGradientsPct = cfDecode(gradEnc, 100, sd).map((g) => Math.round(g * 10) / 10);
    const graphDistances = graphGradientsPct.map((_, i) => Math.min(i * graphInterval, lengthM));

    const steepest =
      typeof ClimbMetrics !== "undefined"
        ? {
            steepest_100m_pct: ClimbMetrics.steepestGradientPct(distances, elevations, 100),
            steepest_1km_pct: ClimbMetrics.steepestGradientPct(distances, elevations, 1000),
          }
        : { steepest_100m_pct: 0, steepest_1km_pct: 0 };

    let gain = 0;
    let loss = 0;
    const gradients = [];
    for (let i = 1; i < elevations.length; i++) {
      const d = distances[i] - distances[i - 1];
      if (elevations[i] > elevations[i - 1]) gain += elevations[i] - elevations[i - 1];
      else loss += elevations[i - 1] - elevations[i];
      if (d > 0) gradients.push((100 * (elevations[i] - elevations[i - 1])) / d);
    }

    const lons = coordinates.map((c) => c[0]);
    const lats = coordinates.map((c) => c[1]);

    const classification =
      typeof ClimbMetrics !== "undefined"
        ? ClimbMetrics.climbCategory({ climbfinder: { category }, difficulty_score: parseDifficulty(category) })
        : category && String(category).trim().toUpperCase() || null;

    return {
      id: slug,
      name,
      region: regionLabel,
      country,
      classification,
      climbfinder: {
        id: idM ? parseInt(idM[1], 10) : null,
        slug,
        url: `https://climbfinder.com/en/climbs/${slug}`,
        category,
      },
      stats: {
        length_m: lengthM,
        elevation_gain_m: Math.round(gain),
        elevation_loss_m: Math.round(loss),
        avg_gradient_pct: lengthM ? Math.round((100 * gain) / lengthM * 10) / 10 : 0,
        max_gradient_pct: gradients.length ? Math.round(Math.max(...gradients) * 10) / 10 : 0,
        steepest_100m_pct: steepest.steepest_100m_pct,
        steepest_1km_pct: steepest.steepest_1km_pct,
        classification,
      },
      difficulty_score: parseDifficulty(category),
      geometry: { type: "LineString", coordinates },
      profile: {
        distances_m: distances,
        elevations_m: elevations.map((e) => Math.round(e * 10) / 10),
        path_interval_m: pathInterval,
        graph_interval_m: graphInterval,
        graph_distances_m: graphDistances,
        graph_gradients_pct: graphGradientsPct,
      },
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      start: { lng: coordinates[0][0], lat: coordinates[0][1] },
      summit: { lng: coordinates.at(-1)[0], lat: coordinates.at(-1)[1] },
      tags: [...tags],
      sources: [
        {
          name: "climbfinder",
          url: `https://climbfinder.com/en/climbs/${slug}`,
          note: "Browser import via climb page HTML",
        },
      ],
    };
  }

  function slugifyName(input) {
    return input
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function extractSlugFromLine(line) {
    const s = line.trim();
    if (!s) return "";
    const urlM = s.match(/climbfinder\.com\/(?:en\/)?climbs\/([a-z0-9-]+)/i);
    if (urlM) return urlM[1];
    if (/^[a-z0-9-]+$/i.test(s) && !s.includes(" ")) return s.toLowerCase();
    return slugifyName(s);
  }

  async function resolveSlug(line) {
    const raw = line.trim();
    if (!raw) return null;
    const candidates = [];
    const fromUrl = extractSlugFromLine(raw);
    if (fromUrl) candidates.push(fromUrl);
    const slugified = slugifyName(raw);
    if (slugified && !candidates.includes(slugified)) candidates.push(slugified);

    let lastErr;
    for (const slug of candidates) {
      try {
        const html = await fetchHtml(`https://climbfinder.com/en/climbs/${slug}`);
        if (html.includes("pathElevationsEnc")) return slug;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error(`Geen klim gevonden voor "${raw}" — gebruik de slug uit de Climbfinder-URL`);
  }

  function resolveClimbsDataUrl(relativePath) {
    return new URL(relativePath, window.location.href).href;
  }

  async function loadRegionsCatalog() {
    const url = resolveClimbsDataUrl("data/climbfinder-regions.json");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Regio-lijst HTTP ${res.status} — ${url}`);
    }
    return res.json();
  }

  async function loadPopularRankingSlugs(localityId) {
    const res = await fetch(resolveClimbsDataUrl(`data/rankings/${localityId}-popular-slugs.json`), {
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(
        `Geen ranking-slugs voor regio ${localityId}. Lokaal: python scripts/refresh_ranking_slugs.py --locality ${localityId}`
      );
    }
    const data = await res.json();
    return data;
  }

  async function resolveLinesToSlugs(lines, onProgress) {
    const slugs = [];
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      onProgress?.({ i: i + 1, total: lines.length, line, status: "resolve" });
      try {
        const slug = await resolveSlug(line);
        if (slug && !slugs.includes(slug)) slugs.push(slug);
      } catch (e) {
        errors.push(`${line}: ${e.message}`);
        onProgress?.({ i: i + 1, total: lines.length, line, status: "resolve_err", error: e.message });
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { slugs, errors };
  }

  async function importSlugs(slugs, options, onProgress) {
    const {
      regionLabel,
      country,
      metaId,
      title,
      tags = ["climbfinder"],
      source = { name: "climbfinder", import: "browser" },
    } = options;
    const climbs = [];
    const errors = [];
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i].trim();
      if (!slug) continue;
      onProgress?.({ i: i + 1, total: slugs.length, slug, status: "fetch" });
      try {
        const html = await fetchHtml(`https://climbfinder.com/en/climbs/${slug}`);
        climbs.push(parseClimbPage(html, slug, regionLabel, country, tags));
        onProgress?.({ i: i + 1, total: slugs.length, slug, status: "ok" });
      } catch (e) {
        errors.push(`${slug}: ${e.message}`);
        onProgress?.({ i: i + 1, total: slugs.length, slug, status: "err", error: e.message });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return {
      schema_version: "1.0",
      meta: {
        id: metaId,
        title,
        country,
        updated_at: new Date().toISOString(),
        count: climbs.length,
        source,
        import_errors: errors,
      },
      climbs,
    };
  }

  global.ClimbfinderBrowser = {
    importSlugs,
    fetchHtml,
    parseClimbPage,
    loadRegionsCatalog,
    loadPopularRankingSlugs,
    resolveLinesToSlugs,
    extractSlugFromLine,
  };
})(window);

/**
 * Climbfinder climb page → JSON (browser, via CORS proxy).
 * Ranking lists need Playwright; use preset slug lists or paste slugs.
 */
(function (global) {
  const CORS_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
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
    throw lastErr || new Error("Kon Climbfinder-pagina niet ophalen (CORS/proxy)");
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
    const pathInterval = parseInt(dataM[6], 10);
    const lengthM = parseInt(dataM[8], 10);
    const elevations = cfDecode(dataM[7], 10, sd);
    const distances = elevations.map((_, i) => Math.min(i * pathInterval, lengthM));

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

    return {
      id: slug,
      name,
      region: regionLabel,
      country,
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
      },
      difficulty_score: parseDifficulty(category),
      geometry: { type: "LineString", coordinates },
      profile: {
        distances_m: distances,
        elevations_m: elevations.map((e) => Math.round(e * 10) / 10),
        path_interval_m: pathInterval,
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

  async function importSlugs(slugs, options, onProgress) {
    const { regionLabel, country, metaId, title, tags = ["climbfinder"] } = options;
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
        source: { name: "climbfinder", import: "browser" },
        import_errors: errors,
      },
      climbs,
    };
  }

  global.ClimbfinderBrowser = { importSlugs, fetchHtml, parseClimbPage };
})(window);

/** Importstatus: site (index.json) vs Climbfinder Popular-total per locality. */
(function (global) {
  function parseLocalityFromMeta(meta) {
    if (!meta) return null;
    const src = meta.source || {};
    if (src.locality_id != null) return Number(src.locality_id);
    const id = meta.id || "";
    const m = /^cf-l(\d+)-/.exec(id);
    if (m) return Number(m[1]);
    if (id === "nl-limburg") return 27;
    return null;
  }

  function parseLocalityFromIndexEntry(entry) {
    if (entry?.locality_id != null) return Number(entry.locality_id);
    const id = entry?.id || "";
    const m = /^cf-l(\d+)-/.exec(id);
    if (m) return Number(m[1]);
    if (id === "nl-limburg") return 27;
    return null;
  }

  /** @returns {Promise<Record<string, { count: number, datasetId: string, title: string }>>} */
  async function loadPublishedByLocality() {
    const indexUrl = new URL("data/index.json", document.baseURI || location.href).href;
    const res = await fetch(indexUrl, { cache: "no-store" });
    if (!res.ok) return {};
    const index = await res.json();
    const out = {};
    for (const entry of index.regions || []) {
      const loc = parseLocalityFromIndexEntry(entry);
      if (loc == null) continue;
      const key = String(loc);
      const prev = out[key];
      const count = entry.count ?? 0;
      if (!prev || count >= prev.count) {
        out[key] = {
          datasetId: entry.id,
          title: entry.displayTitle || entry.title,
          count,
        };
      }
    }
    return out;
  }

  /**
   * @param {number|null|undefined} published
   * @param {number|null|undefined} popularTotal
   * @returns {'none'|'partial'|'full'}
   */
  function statusKey(published, popularTotal) {
    const pub = published || 0;
    if (pub <= 0) return "none";
    if (popularTotal != null && popularTotal > 0 && pub >= popularTotal) return "full";
    return "partial";
  }

  const STATUS_LABEL = {
    none: { short: "○", text: "niet op site" },
    partial: { short: "◐", text: "deels" },
    full: { short: "●", text: "compleet" },
  };

  function formatImportBadge(published, popularTotal) {
    const key = statusKey(published, popularTotal);
    const badge = STATUS_LABEL[key].short;
    const pub = published || 0;
    if (popularTotal != null && popularTotal > 0) {
      return `${badge} ${pub}/${popularTotal}`;
    }
    if (pub > 0) return `${badge} ${pub} op site`;
    return `${badge} —`;
  }

  global.FietsKlimImportStatus = {
    parseLocalityFromMeta,
    parseLocalityFromIndexEntry,
    loadPublishedByLocality,
    statusKey,
    formatImportBadge,
    STATUS_LABEL,
  };
})(typeof window !== "undefined" ? window : globalThis);

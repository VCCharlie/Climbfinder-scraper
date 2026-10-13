/**
 * Schat importplan op de client (zelfde idee als scripts/plan_locality_import.py).
 * Gebruikt region-hierarchy.json + published-locality status.
 */
(function (global) {
  const GLOBAL_SKIP = new Set([1, 25]);
  const EXTRA_SKIP_BY_MACRO = { 36: new Set([44]) };

  let hierarchyCache = null;

  async function loadHierarchy() {
    if (hierarchyCache) return hierarchyCache;
    const url = new URL("data/region-hierarchy.json", document.baseURI || location.href).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Hiërarchie niet geladen (${res.status})`);
    hierarchyCache = await res.json();
    return hierarchyCache;
  }

  function shouldSkipMacroChild(macroId, localityId) {
    if (GLOBAL_SKIP.has(localityId)) return true;
    if (localityId === macroId) return true;
    const extra = EXTRA_SKIP_BY_MACRO[macroId];
    return extra ? extra.has(localityId) : false;
  }

  function isMacroGroupId(localityId, countryIso, hierarchy) {
    for (const block of hierarchy.countries || []) {
      if (countryIso && block.country_iso !== countryIso) continue;
      for (const group of block.groups || []) {
        if (Number(group.locality_id) === localityId) return true;
      }
    }
    return false;
  }

  function findGroupForLocality(localityId, countryIso, hierarchy) {
    for (const block of hierarchy.countries || []) {
      if (countryIso && block.country_iso !== countryIso) continue;
      for (const group of block.groups || []) {
        const macroId = Number(group.locality_id);
        const memberIds = new Set((group.localities || []).map((l) => Number(l.locality_id)));
        if (localityId === macroId || memberIds.has(localityId)) {
          return { block, group, macroId };
        }
      }
    }
    return { block: null, group: null, macroId: null };
  }

  /** Land-niveau locality: regio-naam = land-naam in catalogus. */
  function isCountryLevelRegion(region) {
    if (!region?.country || !region?.name) return false;
    return String(region.name).trim().toLowerCase() === String(region.country).trim().toLowerCase();
  }

  function countBatchSubregions(group, macroId, publishedByLocality, importStatus) {
    let n = 0;
    for (const loc of group.localities || []) {
      const id = Number(loc.locality_id);
      if (shouldSkipMacroChild(macroId, id)) continue;
      const pub = publishedByLocality?.[String(id)]?.count ?? 0;
      const pop = loc.popular_count ?? null;
      let key = "none";
      if (importStatus?.statusKey) {
        key = importStatus.statusKey(pub, pop);
      } else if (pub > 0) {
        key = "partial";
      }
      if (key !== "full") n += 1;
    }
    return n;
  }

  /**
   * @param {object} region — geselecteerde regio (id, name, country, country_iso)
   * @param {Record<string,{count:number}>} publishedByLocality
   * @param {typeof FietsKlimImportStatus} [importStatus]
   */
  async function estimateImportPlan(region, publishedByLocality, importStatus) {
    if (!region?.id) {
      return { mode: "none", regionCount: 0, label: "Kies een regio" };
    }
    const hierarchy = await loadHierarchy();
    const iso = (region.country_iso || "").toUpperCase();
    const lid = Number(region.id);
    const { block, group, macroId } = findGroupForLocality(lid, iso || null, hierarchy);

    if (isMacroGroupId(lid, iso || null, hierarchy) && group) {
      const n = countBatchSubregions(group, lid, publishedByLocality, importStatus);
      return {
        mode: "area",
        regionCount: n,
        macroId: lid,
        countryIso: iso,
        label:
          n > 0
            ? `Importeer gebied (${n} subregio${n === 1 ? "" : "’s"})`
            : "Gebied is al compleet op site",
        hint:
          n > 0
            ? `${n} niet-● subregio(’s): pages=all per regio, dedupe aan het eind.`
            : "Alle subregio’s staan al als ● op de site.",
      };
    }

    if (group && macroId != null) {
      const countryLevel = isCountryLevelRegion(region);
      const isMacroRow = lid === macroId;
      if (isMacroRow || countryLevel) {
        const n = countBatchSubregions(group, macroId, publishedByLocality, importStatus);
        return {
          mode: "area",
          regionCount: n,
          macroId,
          countryIso: String(block?.country_iso || iso),
          label:
            n > 0
              ? `Importeer gebied (${n} subregio${n === 1 ? "" : "’s"})`
              : "Gebied is al compleet op site",
          hint:
            n > 0
              ? `Land/macro → subregio’s (zoals Klimgebieden-batch). ● regio’s worden overgeslagen.`
              : "Geen openstaande subregio’s.",
        };
      }
    }

    return {
      mode: "single",
      regionCount: 1,
      label: "Importeer regio",
      hint: "Één Popular-ranking voor de gekozen regio.",
    };
  }

  global.FietsKlimImportPlan = {
    loadHierarchy,
    estimateImportPlan,
    isCountryLevelRegion,
  };
})(typeof window !== "undefined" ? window : globalThis);

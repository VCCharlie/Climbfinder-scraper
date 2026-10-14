/**
 * Land/regio-keuze voor onderhoud (monolith split + CF-score backfill).
 * Data: data/published-bundle-maintenance.json (rebuild_climb_index.py).
 */
(function (global) {
  let catalog = null;

  async function loadCatalog() {
    if (catalog) return catalog;
    const url = new URL("data/published-bundle-maintenance.json", document.baseURI || location.href).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(
        `Bundle-catalogus niet gevonden (${res.status}). Draai rebuild_climb_index op main.`
      );
    }
    catalog = await res.json();
    return catalog;
  }

  function uniqueCountries(bundles) {
    const map = new Map();
    for (const b of bundles) {
      const iso = b.country || "XX";
      if (!map.has(iso)) {
        map.set(iso, { iso, label: iso, count: 0 });
      }
      map.get(iso).count += 1;
    }
    return [...map.values()].sort((a, b) => a.iso.localeCompare(b.iso));
  }

  function fillSelect(el, options, placeholder) {
    if (!el) return;
    el.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    el.appendChild(empty);
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.disabled) o.disabled = true;
      el.appendChild(o);
    }
  }

  /**
   * @param {object} opts
   * @param {string} opts.countrySelectId
   * @param {string} opts.regionSelectId
   * @param {'monolith'|'scores'} opts.mode
   * @param {string} [opts.hintId]
   * @param {(bundleFile: string, ctx: object) => void} [opts.onRegionChange]
   */
  async function init(opts) {
    const countrySel = document.getElementById(opts.countrySelectId);
    const regionSel = document.getElementById(opts.regionSelectId);
    const hintEl = opts.hintId ? document.getElementById(opts.hintId) : null;
    if (!countrySel || !regionSel) return null;

    const data = await loadCatalog();
    const allBundles = data.bundles || [];

    const countries = uniqueCountries(allBundles);
    fillSelect(
      countrySel,
      countries.map((c) => ({ value: c.iso, label: `${c.iso} (${c.count} datasets)` })),
      "— kies land —"
    );

    function bundlesForCountry(iso) {
      let list = allBundles.filter((b) => (b.country || "XX") === iso);
      if (opts.mode === "monolith") {
        list = list.filter((b) => b.is_country_monolith);
      } else if (opts.mode === "scores") {
        list = list.filter((b) => !b.scores_complete && (b.missing_cf_scores || 0) > 0);
        const hasRegionalBundles = list.some((b) => !b.is_country_monolith);
        if (hasRegionalBundles) {
          list = list.filter((b) => !b.is_country_monolith);
        }
      }
      return list.sort((a, b) =>
        String(a.displayTitle || a.file).localeCompare(String(b.displayTitle || b.file), "nl")
      );
    }

    function refreshRegions() {
      const iso = countrySel.value;
      if (!iso) {
        fillSelect(regionSel, [], "— eerst land —");
        regionSel.disabled = true;
        if (hintEl) hintEl.textContent = "";
        opts.onRegionChange?.("", { countryIso: "" });
        return;
      }
      const list = bundlesForCountry(iso);
      regionSel.disabled = false;

      if (opts.mode === "monolith") {
        if (!list.length) {
          fillSelect(regionSel, [], "Geen land-monolith meer op site (al gesplitst?)");
          regionSel.disabled = true;
          if (hintEl) {
            hintEl.textContent =
              "Dit land heeft geen apart land-niveau JSON-bestand meer in de index — waarschijnlijk al opgesplitst.";
          }
          opts.onRegionChange?.("", { countryIso: iso });
          return;
        }
        fillSelect(
          regionSel,
          list.map((b) => ({
            value: b.file,
            label: `${b.displayTitle} · ${b.count} klimmen · ${b.file}`,
          })),
          "— kies monolith —"
        );
        if (list.length === 1) regionSel.value = list[0].file;
        if (hintEl) hintEl.textContent = "Land-monolith: één groot bestand dat naar subregio’s gesplitst wordt.";
      } else {
        const optsList = [
          {
            value: "__country__",
            label: `— alle ontbrekende scores in ${iso} —`,
          },
        ];
        for (const b of list) {
          optsList.push({
            value: b.file,
            label: `${b.displayTitle} · ${b.missing_cf_scores}/${b.count} zonder score`,
          });
        }
        const catalogStamp = data.updated_at
          ? `Catalogus ${new Date(data.updated_at).toLocaleString("nl-NL")}. `
          : "";
        if (list.length === 0) {
          fillSelect(regionSel, [], `Geen openstaande scores in ${iso}`);
          regionSel.disabled = true;
          if (hintEl) {
            hintEl.textContent = `${catalogStamp}Alle bundles in dit land zijn compleet (scores).`;
          }
        } else {
          fillSelect(regionSel, optsList, "— kies regio of heel land —");
          if (hintEl) {
            hintEl.textContent = `${catalogStamp}${list.length} bundle(s) met ontbrekende scores. Voltooide regio’s verdwijnen na backfill + catalogus-rebuild op main.`;
          }
        }
      }
      emitChange();
    }

    function emitChange() {
      const iso = countrySel.value;
      const val = regionSel.value;
      const bundleFile = val === "__country__" ? "" : val;
      opts.onRegionChange?.(bundleFile, {
        countryIso: iso,
        allCountry: val === "__country__",
      });
    }

    countrySel.addEventListener("change", refreshRegions);
    regionSel.addEventListener("change", emitChange);
    refreshRegions();

    return { reload: async () => { catalog = null; await loadCatalog(); refreshRegions(); } };
  }

  global.FietsKlimBundlePicker = { init, loadCatalog };
})(typeof window !== "undefined" ? window : globalThis);

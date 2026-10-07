/** Importpagina: klimgebieden-hiërarchie (NL/BE/FR/…). */
(function (global) {
  const TARGET_ISO = ["NL", "BE", "FR", "DE", "IT", "ES", "CH", "AT"];

  async function loadHierarchy() {
    const url = new URL("data/region-hierarchy.json", document.baseURI || location.href).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Hiërarchie niet gevonden (HTTP ${res.status})`);
    return res.json();
  }

  let labelCountsCache = null;

  async function loadLabelCounts() {
    if (labelCountsCache) return labelCountsCache;
    try {
      const url = new URL(
        "data/published-label-counts-by-locality.json",
        document.baseURI || location.href
      ).href;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        labelCountsCache = { by_display_locality_id: {}, by_resolved_locality_id: {} };
        return labelCountsCache;
      }
      labelCountsCache = await res.json();
    } catch {
      labelCountsCache = { by_display_locality_id: {}, by_resolved_locality_id: {} };
    }
    return labelCountsCache;
  }

  /**
   * @param {object} opts
   * @param {(localityId: number, regionRow: object) => void} opts.onPickImport
   * @param {() => Record<string, {count:number}>} [opts.publishedByLocality]
   * @param {typeof FietsKlimImportStatus} [opts.importStatus]
   */
  async function init(opts) {
    const countrySel = document.getElementById("hierCountrySelect");
    const treeEl = document.getElementById("hierTree");
    if (!countrySel || !treeEl) return;

    let hierarchy = null;
    let labelCounts = { by_display_locality_id: {} };
    try {
      [hierarchy, labelCounts] = await Promise.all([loadHierarchy(), loadLabelCounts()]);
    } catch (e) {
      treeEl.innerHTML = `<p class="hint" style="color:#b91c1c">${e.message}</p>`;
      return;
    }

    countrySel.innerHTML = "";
    for (const iso of TARGET_ISO) {
      const block = hierarchy.countries?.find((c) => c.country_iso === iso);
      if (!block) continue;
      const opt = document.createElement("option");
      opt.value = iso;
      opt.textContent = block.country || iso;
      countrySel.appendChild(opt);
    }

    function badgeForLocality(id) {
      const labeled = labelCounts.by_display_locality_id?.[String(id)] ?? 0;
      if (typeof opts.importStatus === "undefined" || !opts.publishedByLocality) {
        return labeled > 0 ? `≈ ${labeled} gelabeld` : "";
      }
      const pub = opts.publishedByLocality()?.[String(id)]?.count ?? 0;
      const importBadge =
        typeof FietsKlimImportStatus !== "undefined"
          ? FietsKlimImportStatus.formatImportBadge(pub, null)
          : pub > 0
            ? `● ${pub}`
            : "○";
      if (labeled > 0 && pub <= 0) {
        return `${importBadge} · ≈${labeled} gelabeld op site`;
      }
      if (labeled > 0 && pub > 0 && labeled !== pub) {
        return `${importBadge} · ≈${labeled} gelabeld`;
      }
      return importBadge;
    }

    function renderLocalityRow(loc, isMacro = false) {
      const row = document.createElement("div");
      row.className = "hier-loc-row" + (isMacro ? " hier-loc-row--macro" : "");
      const badge = badgeForLocality(loc.locality_id);
      const pop = loc.popular_count != null ? ` · ~${loc.popular_count} Popular` : "";
      row.innerHTML = `<span class="hier-loc-name">${loc.name || loc.name_nl}${pop}</span> <span class="hier-loc-meta">l=${loc.locality_id} ${badge}</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = isMacro ? "secondary" : "";
      btn.textContent = "Import";
      btn.addEventListener("click", () => {
        opts.onPickImport(loc.locality_id, loc);
      });
      row.appendChild(btn);
      return row;
    }

    function renderTree() {
      const iso = countrySel.value;
      const block = hierarchy.countries?.find((c) => c.country_iso === iso);
      treeEl.innerHTML = "";
      if (!block) {
        treeEl.innerHTML = '<p class="hint">Geen data voor dit land.</p>';
        return;
      }

      for (const group of block.groups || []) {
        const details = document.createElement("details");
        details.className = "hier-group";
        details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = `${group.name_nl || group.name} (l=${group.locality_id})`;
        details.appendChild(summary);
        const macroRow = renderLocalityRow(
          {
            locality_id: group.locality_id,
            name: group.name,
            name_nl: group.name_nl,
            popular_count: group.popular_count,
          },
          true
        );
        details.appendChild(macroRow);
        const childWrap = document.createElement("div");
        childWrap.className = "hier-children";
        for (const loc of group.localities || []) {
          childWrap.appendChild(renderLocalityRow(loc, false));
        }
        if (!group.localities?.length) {
          childWrap.innerHTML = '<p class="hint">Geen kleinere regio’s automatisch gekoppeld — kies macro-import of zoek l=id.</p>';
        }
        details.appendChild(childWrap);
        treeEl.appendChild(details);
      }

      if (block.ungrouped?.length) {
        const details = document.createElement("details");
        details.className = "hier-group";
        const summary = document.createElement("summary");
        summary.textContent = `Overig (${block.ungrouped.length})`;
        details.appendChild(summary);
        const wrap = document.createElement("div");
        wrap.className = "hier-children";
        for (const loc of block.ungrouped.slice(0, 80)) {
          wrap.appendChild(renderLocalityRow(loc, false));
        }
        if (block.ungrouped.length > 80) {
          const p = document.createElement("p");
          p.className = "hint";
          p.textContent = `… en ${block.ungrouped.length - 80} meer — gebruik regio-dropdown of zoeken.`;
          wrap.appendChild(p);
        }
        details.appendChild(wrap);
        treeEl.appendChild(details);
      }
    }

    countrySel.addEventListener("change", renderTree);
    renderTree();
  }

  global.FietsKlimRegionHierarchy = { init, loadHierarchy };
})(typeof window !== "undefined" ? window : globalThis);

/** Importpagina: duplicaten tonen en verwijderen via GitHub Actions. */
(function (global) {
  const PAGE_SIZE = 40;
  const MAX_REMOVALS_PER_RUN = 120;

  let report = null;
  let filteredGroups = [];
  let page = 0;
  /** @type {Set<string>} keys dataset_id::climb_id */
  let selectedRemovals = new Set();

  function removalKey(datasetId, climbId) {
    return `${datasetId}::${climbId}`;
  }

  async function loadDuplicateReport() {
    const url = new URL("data/published-duplicate-climbs.json", document.baseURI || location.href).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Duplicatenrapport niet gevonden (HTTP ${res.status}). Run rebuild_climb_index op main.`);
    return res.json();
  }

  function applyFilter(query) {
    const q = (query || "").trim().toLowerCase();
    if (!report?.groups) {
      filteredGroups = [];
      return;
    }
    if (!q) {
      filteredGroups = report.groups;
      return;
    }
    filteredGroups = report.groups.filter(
      (g) =>
        g.name?.toLowerCase().includes(q) ||
        g.slug?.toLowerCase().includes(q) ||
        g.copies?.some((c) => c.title?.toLowerCase().includes(q) || c.dataset_id?.toLowerCase().includes(q))
    );
  }

  function suggestKeepCopy(copies) {
    if (!copies?.length) return null;
    return [...copies].sort(
      (a, b) => (a.region_count || 0) - (b.region_count || 0) || String(a.dataset_id).localeCompare(b.dataset_id)
    )[0];
  }

  function buildRemovalsPayload() {
    const out = [];
    for (const key of selectedRemovals) {
      const [dataset_id, climb_id] = key.split("::");
      if (dataset_id && climb_id) out.push({ dataset_id, climb_id });
    }
    return out;
  }

  function validateRemovals(payload) {
    if (!payload.length) return "Selecteer minstens één kopie om te verwijderen.";
    if (payload.length > MAX_REMOVALS_PER_RUN) {
      return `Max. ${MAX_REMOVALS_PER_RUN} per run — deselecteer of doe meerdere runs.`;
    }
    for (const g of report?.groups || []) {
      const copies = g.copies || [];
      if (copies.length < 2) continue;
      let removeCount = 0;
      for (const c of copies) {
        if (selectedRemovals.has(removalKey(c.dataset_id, c.climb_id))) removeCount += 1;
      }
      if (removeCount >= copies.length) {
        return `"${g.name}": laat minstens één regio-kopie staan.`;
      }
    }
    return null;
  }

  function ghRemoveCommand(payload) {
    const json = JSON.stringify(payload);
    const escaped = json.replace(/'/g, "'\\''");
    return (
      `gh workflow run remove-duplicate-climbs.yml \\\n` +
      `  -f removals_json='${escaped}'`
    );
  }

  function renderList(container, summaryEl, pagerEl, onLog) {
    if (!container) return;
    const total = filteredGroups.length;
    const start = page * PAGE_SIZE;
    const slice = filteredGroups.slice(start, start + PAGE_SIZE);

    if (summaryEl && report) {
      summaryEl.textContent =
        `${report.duplicate_groups ?? total} dubbele klimmen (slug) · ` +
        `${report.extra_rows ?? "?"} extra regels · ${selectedRemovals.size} geselecteerd om te verwijderen`;
    }

    if (!slice.length) {
      container.innerHTML = '<p class="hint">Geen duplicaten in dit filter.</p>';
      if (pagerEl) pagerEl.innerHTML = "";
      return;
    }

    container.innerHTML = "";
    for (const g of slice) {
      const keep = suggestKeepCopy(g.copies);
      const block = document.createElement("article");
      block.className = "dup-group";
      const title = document.createElement("h3");
      title.className = "dup-group-title";
      title.textContent = g.name;
      const meta = document.createElement("p");
      meta.className = "hint dup-group-slug";
      meta.textContent = `slug: ${g.slug} · ${g.copies.length}× op site`;
      block.appendChild(title);
      block.appendChild(meta);

      const list = document.createElement("ul");
      list.className = "dup-copy-list";
      for (const c of g.copies) {
        const li = document.createElement("li");
        const key = removalKey(c.dataset_id, c.climb_id);
        const isKeep = keep && c.dataset_id === keep.dataset_id && c.climb_id === keep.climb_id;
        const label = document.createElement("label");
        label.className = "dup-copy-row" + (isKeep ? " dup-copy-row--suggest-keep" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selectedRemovals.has(key);
        cb.dataset.removalKey = key;
        cb.addEventListener("change", () => {
          if (cb.checked) selectedRemovals.add(key);
          else selectedRemovals.delete(key);
          if (summaryEl && report) {
            summaryEl.textContent =
              `${report.duplicate_groups} dubbele klimmen · ${report.extra_rows} extra regels · ${selectedRemovals.size} geselecteerd`;
          }
        });
        const text = document.createElement("span");
        const loc = c.locality_id != null ? ` · l=${c.locality_id}` : "";
        text.innerHTML =
          `<strong>${c.title || c.dataset_id}</strong> ` +
          `<span class="muted">(${c.dataset_id}${loc}, ${c.region_count ?? "?"} klimmen in bestand)</span>` +
          (isKeep ? ' <span class="dup-keep-tag">aanbevolen behouden</span>' : "");
        label.appendChild(cb);
        label.appendChild(text);
        li.appendChild(label);
        list.appendChild(li);
      }
      block.appendChild(list);

      const rowBtn = document.createElement("button");
      rowBtn.type = "button";
      rowBtn.className = "dup-row-action secondary";
      rowBtn.textContent = "Selecteer extra kopieën (behoud smallere regio)";
      rowBtn.addEventListener("click", () => {
        for (const c of g.copies) {
          if (keep && c.dataset_id === keep.dataset_id && c.climb_id === keep.climb_id) continue;
          selectedRemovals.add(removalKey(c.dataset_id, c.climb_id));
        }
        renderList(container, summaryEl, pagerEl, onLog);
      });
      block.appendChild(rowBtn);
      container.appendChild(block);
    }

    if (pagerEl) {
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      pagerEl.innerHTML = "";
      if (pages > 1) {
        const prev = document.createElement("button");
        prev.type = "button";
        prev.className = "secondary";
        prev.textContent = "← Vorige";
        prev.disabled = page <= 0;
        prev.addEventListener("click", () => {
          page = Math.max(0, page - 1);
          renderList(container, summaryEl, pagerEl, onLog);
        });
        const next = document.createElement("button");
        next.type = "button";
        next.className = "secondary";
        next.textContent = "Volgende →";
        next.disabled = page >= pages - 1;
        next.addEventListener("click", () => {
          page = Math.min(pages - 1, page + 1);
          renderList(container, summaryEl, pagerEl, onLog);
        });
        const info = document.createElement("span");
        info.className = "hint";
        info.style.marginLeft = "0.5rem";
        info.textContent = `Pagina ${page + 1} / ${pages}`;
        pagerEl.appendChild(prev);
        pagerEl.appendChild(next);
        pagerEl.appendChild(info);
      }
    }
  }

  /**
   * @param {object} opts
   * @param {() => boolean} opts.isUnlocked
   * @param {() => object|null} opts.githubImportConfig
   * @param {(msg: string) => void} opts.log
   * @param {(err: unknown) => string} [opts.formatCallableError]
   */
  function init(opts) {
    const listEl = document.getElementById("dupList");
    const summaryEl = document.getElementById("dupSummary");
    const pagerEl = document.getElementById("dupPager");
    const searchEl = document.getElementById("dupSearch");
    const loadBtn = document.getElementById("dupReloadBtn");
    const applyBtn = document.getElementById("dupApplyBtn");
    const cmdTa = document.getElementById("dupGhCmd");
    const copyBtn = document.getElementById("dupCopyGhBtn");
    if (!listEl) return;

    async function refreshReport() {
      listEl.innerHTML = '<p class="hint">Duplicatenrapport laden…</p>';
      try {
        report = await loadDuplicateReport();
        page = 0;
        selectedRemovals = new Set();
        applyFilter(searchEl?.value || "");
        renderList(listEl, summaryEl, pagerEl, opts.log);
      } catch (e) {
        listEl.innerHTML = `<p class="hint" style="color:#b91c1c">${e.message}</p>`;
      }
    }

    searchEl?.addEventListener("input", () => {
      page = 0;
      applyFilter(searchEl.value);
      renderList(listEl, summaryEl, pagerEl, opts.log);
    });

    loadBtn?.addEventListener("click", () => void refreshReport());

    copyBtn?.addEventListener("click", () => {
      if (!cmdTa?.value) return;
      cmdTa.select();
      navigator.clipboard?.writeText(cmdTa.value);
      opts.log("Verwijder-commando gekopieerd.");
    });

    applyBtn?.addEventListener("click", async () => {
      const payload = buildRemovalsPayload();
      const err = validateRemovals(payload);
      if (err) {
        opts.log("FOUT: " + err);
        return;
      }
      if (!opts.isUnlocked()) {
        opts.log("FOUT: eerst inloggen.");
        return;
      }
      if (
        !confirm(
          `${payload.length} klim(men) uit geselecteerde regio-bestanden verwijderen?\n\nDit maakt een commit op GitHub (main) via Actions.`
        )
      ) {
        return;
      }
      cmdTa.value = ghRemoveCommand(payload);
      applyBtn.disabled = true;
      try {
        const cfg = opts.githubImportConfig?.();
        if (cfg?.enabled && typeof firebase !== "undefined" && firebase.app) {
          opts.log(`Start verwijderen: ${payload.length} kopie(ën)…`);
          const fn = firebase
            .app()
            .functions(cfg.region || "europe-west1")
            .httpsCallable("requestClimbDuplicateRemovals");
          const res = await fn({ removals: payload });
          opts.log(res.data.message || "Workflow gestart.");
          if (res.data.actionsUrl) window.open(res.data.actionsUrl, "_blank", "noopener");
        } else {
          opts.log("Firebase niet actief — start handmatig op GitHub:");
          opts.log("");
          opts.log(cmdTa.value);
          opts.log("");
          opts.log("→ Actions → Remove duplicate climbs → Run workflow");
          window.open(
            "https://github.com/VCCharlie/Climbfinder-scraper/actions/workflows/remove-duplicate-climbs.yml",
            "_blank",
            "noopener"
          );
        }
      } catch (e) {
        const fmt = opts.formatCallableError || ((x) => x?.message || String(x));
        opts.log("FOUT: " + fmt(e));
      } finally {
        applyBtn.disabled = false;
      }
    });

    global.FietsKlimDuplicateAdmin = { refreshReport };
  }

  global.FietsKlimDuplicateAdminInit = init;
})(typeof window !== "undefined" ? window : globalThis);

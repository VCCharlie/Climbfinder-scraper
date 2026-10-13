(() => {
"use strict";
    let lastBundle = null;
    let regionsCatalog = null;
    let regionPopularCounts = null;
    let publishedByLocality = null;
    let selectedRegion = null;
    let regionsBooted = false;
    let regionPicker = null;
    let activeImportTab = "import";
    let activeImportSubTab = "region";
    let climbSlugSearchIndex = null;
    let climbSearchIndexLoading = null;

    function log(msg) {
      const el = document.getElementById("log");
      el.textContent += msg + "\n";
      el.scrollTop = el.scrollHeight;
    }

    const GITHUB_REPO = (window.FIETSKLIM_AUTH_CONFIG?.githubImport?.repo) || "VCCharlie/Climbfinder-scraper";

    function githubImportConfig() {
      return window.FIETSKLIM_AUTH_CONFIG?.githubImport;
    }

    function githubOneClickActive() {
      const cfg = githubImportConfig();
      return !!(cfg?.enabled && typeof firebase !== "undefined" && firebase.app);
    }

    function formatCallableError(e) {
      if (!e) return "Onbekende fout";
      const code = e.code ? String(e.code).replace(/^functions\//, "") : "";
      const msg = e.message || String(e);
      if (code && !msg.includes(code)) return `${msg} (${code})`;
      return msg;
    }

    async function refreshPrimaryImportUi() {
      const btn = document.getElementById("startGithubBtn");
      const meta = document.getElementById("primaryImportMeta");
      const planHint = document.getElementById("importPlanHint");
      if (!btn || !selectedRegion) {
        if (btn) {
          btn.textContent = "Importeer regio";
          btn.disabled = true;
        }
        if (meta) meta.textContent = "Kies eerst een regio (dropdown, kaart of klimgebieden).";
        return;
      }
      btn.disabled = false;
      if (typeof FietsKlimImportPlan === "undefined") {
        btn.textContent = "Importeer";
        return;
      }
      try {
        const plan = await FietsKlimImportPlan.estimateImportPlan(
          selectedRegion,
          publishedByLocality,
          typeof FietsKlimImportStatus !== "undefined" ? FietsKlimImportStatus : undefined
        );
        btn.textContent = plan.label || "Importeer";
        if (plan.mode === "area" && plan.regionCount <= 0) btn.disabled = true;
        if (meta) meta.textContent = plan.hint || "";
        if (planHint && plan.mode === "area" && plan.regionCount > 1) {
          planHint.innerHTML =
            `<strong>Gebied-import:</strong> ${plan.regionCount} subregio(’s) via unified plan (pages=all, dedupe aan het eind).`;
        }
      } catch (e) {
        if (meta) meta.textContent = e.message;
      }
    }

    function cfPopularCount(localityId) {
      if (typeof ClimbfinderBrowser === "undefined") return null;
      return ClimbfinderBrowser.popularCountForLocality(regionPopularCounts, localityId);
    }

    function regionSelectLabel(r) {
      const total = cfPopularCount(r.id);
      const pub = publishedByLocality?.[String(r.id)]?.count ?? 0;
      const badge =
        typeof FietsKlimImportStatus !== "undefined"
          ? `${FietsKlimImportStatus.formatImportBadge(pub, total)} · `
          : "";
      const overlap =
        typeof FietsKlimImportStatus !== "undefined"
          ? FietsKlimImportStatus.formatOverlapHint(r.id, publishedByLocality)
          : "";
      const suffix = total != null ? ` · ~${total} Popular` : "";
      return `${badge}${r.name} (l=${r.id}${suffix})${overlap}`;
    }

    async function refreshSiteDatabaseSummary() {
      const el = document.getElementById("siteDatabaseSummary");
      if (!el) return;
      try {
        const res = await fetch(new URL("data/index.json", location.href).href, { cache: "no-store" });
        if (!res.ok) return;
        const index = await res.json();
        const total = index.total_climbs ?? (index.regions || []).reduce((s, r) => s + (r.count || 0), 0);
        const unique = index.unique_climbs;
        const dup = index.duplicate_rows_across_regions;
        const n = index.region_count ?? (index.regions || []).length;
        let text = `Site-database: ${Number(total).toLocaleString("nl-NL")} klimmen in ${n} regio-dataset(s)`;
        if (unique != null && dup > 0) {
          text += ` · ${Number(unique).toLocaleString("nl-NL")} unieke klimmen (${Number(dup).toLocaleString("nl-NL")} dubbele regels door overlap)`;
        }
        el.textContent = text;
      } catch {
        /* optional */
      }
    }

    function countryCode(region) {
      if (region.country_iso) return region.country_iso;
      const map = {
        France: "FR", Italy: "IT", Spain: "ES", Netherlands: "NL", Belgium: "BE",
        Switzerland: "CH", Austria: "AT", Germany: "DE", "United Kingdom": "GB",
        Portugal: "PT", Andorra: "AD", Slovenia: "SI", Croatia: "HR", Norway: "NO",
        USA: "US", Colombia: "CO", Denmark: "DK",
      };
      return map[region.country] || "XX";
    }

    const SLUGS_PER_RANKING_PAGE = 25;
    const DEFAULT_IMPORT_LIMIT = 50;
    /** Vanaf dit aantal: workflow gebruikt pages=all (volledige ranking scrapen tot limit). */
    const USE_ALL_PAGES_FROM_LIMIT = 500;
    let importLimitUserEdited = false;

    function suggestedImportLimitForLocality(localityId) {
      const cfTotal = cfPopularCount(localityId);
      if (cfTotal == null || !Number.isFinite(cfTotal)) return DEFAULT_IMPORT_LIMIT;
      return Math.min(2000, Math.max(1, cfTotal));
    }

    function applySuggestedImportLimit(region) {
      if (!region || importLimitUserEdited) return;
      const el = document.getElementById("importClimbLimit");
      if (!el) return;
      const suggested = suggestedImportLimitForLocality(region.id);
      el.value = String(suggested);
    }

    function readImportLimit() {
      const el = document.getElementById("importClimbLimit");
      let n = parseInt(el?.value, 10);
      if (!Number.isFinite(n) || n < 1) n = DEFAULT_IMPORT_LIMIT;
      if (n > 2000) n = 2000;
      if (el && String(n) !== el.value) el.value = String(n);
      return n;
    }

    function pagesAndLimitForImport(limit, region) {
      const lim = Math.max(1, Math.min(2000, limit));
      if (lim >= USE_ALL_PAGES_FROM_LIMIT || (region?.id === 27 && lim >= 650)) {
        return { pages: "all", limit: String(lim) };
      }
      const pages = Math.max(1, Math.ceil(lim / SLUGS_PER_RANKING_PAGE));
      return { pages: String(pages), limit: String(lim) };
    }

    function refreshImportLimitHint() {
      const hint = document.getElementById("importLimitHint");
      if (!hint) return;
      const limit = readImportLimit();
      const { pages, limit: limStr } = pagesAndLimitForImport(limit, selectedRegion);
      const slugCap = pages === "all" ? limStr : String(Number(pages) * SLUGS_PER_RANKING_PAGE);
      const cfTotal = selectedRegion ? cfPopularCount(selectedRegion.id) : null;
      const cfNote =
        cfTotal != null ? ` · Climbfinder Popular in regio: <strong>${cfTotal}</strong>` : "";
      hint.innerHTML =
        `Import max. <strong>${limStr}</strong> klimmen · workflow: <code>pages=${pages}</code>, <code>limit=${limStr}</code>` +
        (pages !== "all"
          ? ` (tot ${slugCap} slugs ophalen uit ranking)`
          : " (alle rankingpagina’s tot limit)") +
        cfNote;
    }

    /** GitHub Actions: pages × 25 = max slugs (limit kan niet meer importeren dan dat). */
    function workflowPayload(region) {
      const cc = countryCode(region);
      const limit = readImportLimit();
      const { pages, limit: limitStr } = pagesAndLimitForImport(limit, region);
      const base = {
        locality: String(region.id),
        pages,
        meta_id: metaIdFromRegion(region),
        title: region.name,
        country: cc,
        region_label: region.name,
        limit: limitStr,
        publish_to_site: "true",
        merge_into: "",
      };
      return base;
    }

    function ghWorkflowCommand(payload) {
      const f = (k, v) => `-f ${k}=${JSON.stringify(String(v))}`;
      return (
        `gh workflow run climbfinder-import.yml \\\n` +
        `  ${f("locality", payload.locality)} \\\n` +
        `  ${f("pages", payload.pages)} \\\n` +
        `  ${f("meta_id", payload.meta_id)} \\\n` +
        `  ${f("title", payload.title)} \\\n` +
        `  ${f("country", payload.country)} \\\n` +
        `  ${f("region_label", payload.region_label)} \\\n` +
        `  ${f("limit", payload.limit)} \\\n` +
        `  -f publish_to_site=${JSON.stringify(String(payload.publish_to_site ?? "true"))}` +
        (payload.merge_into ? ` \\\n  ${f("merge_into", payload.merge_into)}` : "")
      );
    }

    function refreshGhCommand() {
      refreshImportLimitHint();
      const ta = document.getElementById("ghCmd");
      if (!selectedRegion) {
        ta.value = "# Kies een regio…";
        return;
      }
      ta.value = ghWorkflowCommand(workflowPayload(selectedRegion));
    }

    function metaIdFromRegion(r) {
      return `cf-l${r.id}-${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    }

    async function fetchIndexEntry(metaId) {
      const res = await fetch(new URL("data/index.json", document.baseURI || location.href).href, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`index.json (${res.status})`);
      const index = await res.json();
      return (index.regions || []).find((r) => r.id === metaId) || null;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** Na GitHub dispatch: poll tot count in index.json verandert (publish naar Pages). */
    async function pollSiteAfterImport(metaId, baselineCount, maxMs = 25 * 60 * 1000) {
      const start = Date.now();
      let attempt = 0;
      log(`Wacht op publish naar site voor ${metaId} (start: ${baselineCount} klimmen)…`);
      while (Date.now() - start < maxMs) {
        attempt += 1;
        await sleep(attempt === 1 ? 20000 : 15000);
        try {
          const entry = await fetchIndexEntry(metaId);
          const count = entry?.count ?? 0;
          const title = entry?.displayTitle || entry?.title || metaId;
          if (!entry && baselineCount === 0) {
            log(`  [${attempt}] nog niet in index.json…`);
            continue;
          }
          if (count !== baselineCount || (baselineCount === 0 && count > 0)) {
            log(`✓ Site bijgewerkt: ${title} → ${count} klimmen (was ${baselineCount}). Open Database + hard refresh.`);
            if (typeof FietsKlimImportStatus !== "undefined" && selectedRegion) {
              void FietsKlimImportStatus.loadPublishedByLocality().then(() => updateRankingMeta());
            }
            return;
          }
          log(`  [${attempt}] nog ${count} klimmen op site — workflow waarschijnlijk bezig…`);
        } catch (e) {
          log(`  [${attempt}] ${e.message}`);
        }
      }
      log("Timeout (25 min): geen wijziging in index.json. Controleer GitHub Actions.");
    }

    let duplicatesLoaded = false;
    let hierarchyInited = false;

    function findRegionInCatalog(localityId) {
      if (!regionsCatalog) return null;
      for (const block of regionsCatalog.countries) {
        const r = block.regions.find((x) => x.id === localityId);
        if (r) return { ...r, country: block.country, country_iso: r.country_iso || null };
      }
      return null;
    }

    function applyRegionSelection(found, localityId) {
      const countrySel = document.getElementById("countrySelect");
      countrySel.value = found.country;
      fillRegionSelect();
      const regionSel = document.getElementById("regionSelect");
      regionSel.value = String(localityId);
      selectedRegion = found;
      updateRankingMeta();
      refreshGhCommand();
    }

    async function callGithubWorkflow(callableName, payload, label, workflowFileFallback) {
      const cfg = githubImportConfig();
      if (!cfg?.enabled || typeof firebase === "undefined" || !firebase.app) {
        throw new Error("Firebase import niet geconfigureerd. Zie docs/auth/GITHUB_IMPORT.md");
      }
      const fn = firebase.app().functions(cfg.region || "europe-west1").httpsCallable(callableName);
      const res = await fn(payload || {});
      const data = res.data || {};
      if (typeof FietsKlimActivityFeed !== "undefined") {
        FietsKlimActivityFeed.trackDispatchResponse(label, {
          workflowFile: data.workflowFile || workflowFileFallback,
          dispatchedAtMs: data.dispatchedAtMs,
          actionsUrl: data.actionsUrl,
        }, log);
      }
      log(data.message || "Workflow gestart.");
      return data;
    }

    async function triggerSmartImport() {
      const btn = document.getElementById("startGithubBtn");
      if (!isUnlocked()) {
        log("FOUT: eerst inloggen.");
        return;
      }
      if (!selectedRegion) {
        log("FOUT: kies eerst een regio.");
        return;
      }
      const plan =
        typeof FietsKlimImportPlan !== "undefined"
          ? await FietsKlimImportPlan.estimateImportPlan(
              selectedRegion,
              publishedByLocality,
              typeof FietsKlimImportStatus !== "undefined" ? FietsKlimImportStatus : undefined
            )
          : { mode: "single", regionCount: 1 };

      if (plan.mode === "area" && plan.regionCount <= 0) {
        log("Dit gebied is al volledig geïmporteerd (●).");
        return;
      }

      if (plan.mode === "area" && plan.regionCount > 0) {
        const ok = confirm(
          `Importeer gebied “${selectedRegion.name}” (l=${selectedRegion.id})?\n\n` +
            `Ongeveer ${plan.regionCount} subregio(’s) met ○/◐ via unified importplan.\n` +
            `pages=all per regio, dedupe aan het eind. Kan lang duren.\n\nDoorgaan?`
        );
        if (!ok) return;
      }

      btn.disabled = true;
      const payload = workflowPayload(selectedRegion);
      let baselineCount = 0;
      if (String(payload.publish_to_site) !== "false") {
        try {
          baselineCount = (await fetchIndexEntry(payload.meta_id))?.count ?? 0;
        } catch {
          /* optional */
        }
      }
      try {
        await callGithubWorkflow(
          "requestClimbfinderImport",
          payload,
          `Import: ${selectedRegion.name}`,
          "climbfinder-import.yml"
        );
        if (String(payload.publish_to_site) !== "false") {
          void pollSiteAfterImport(payload.meta_id, baselineCount);
        }
      } catch (e) {
        log("FOUT: " + formatCallableError(e));
      } finally {
        btn.disabled = false;
        void refreshPrimaryImportUi();
      }
    }

    async function importAreaForLocality(localityId, ctx) {
      const found = findRegionInCatalog(localityId);
      if (!found) {
        log(`FOUT: regio l=${localityId} niet in catalogus.`);
        return;
      }
      applyRegionSelection(found, localityId);
      regionPicker?.syncFromDropdown?.();
      setTab("import", "region");
      await refreshPrimaryImportUi();
      void triggerSmartImport();
    }

    function pickRegionForImport(localityId, { startGithub = false } = {}) {
      const found = findRegionInCatalog(localityId);
      if (!found) return false;
      applyRegionSelection(found, localityId);
      regionPicker?.syncFromDropdown?.();
      setTab("import", "region");
      log(
        `Regio gekozen: ${found.name} (l=${localityId})` +
          (startGithub
            ? " — GitHub import starten…"
            : " — pas aantal klimmen aan en klik Start serverimport (tab Regio).")
      );
      if (startGithub) void triggerSmartImport();
      else {
        requestAnimationFrame(() => document.getElementById("importClimbLimit")?.focus({ preventScroll: true }));
      }
      return true;
    }

    async function pickLocalityOnMainMap(localityId, { quiet = false } = {}) {
      const found = findRegionInCatalog(localityId);
      if (!found) return false;
      applyRegionSelection(found, localityId);
      if (quiet) {
        setTab("import", "map");
        if (!regionPicker) await initRegionPicker();
        await regionPicker?.pickLocality(localityId);
      } else {
        regionPicker?.syncFromDropdown?.();
        setTab("import", "region");
      }
      return true;
    }

    function setTab(main, sub) {
      const subTabs = ["region", "map", "hierarchy"];
      if (subTabs.includes(main)) {
        sub = main;
        main = "import";
      }
      if (sub) activeImportSubTab = sub;
      activeImportTab = main;

      document.getElementById("tabImport")?.classList.toggle("active", main === "import");
      document.getElementById("tabClean")?.classList.toggle("active", main === "clean");
      document.getElementById("tabMaintenance")?.classList.toggle("active", main === "maintenance");

      document.getElementById("panelImport")?.classList.toggle("active", main === "import");
      document.getElementById("panelClean")?.classList.toggle("active", main === "clean");
      document.getElementById("panelMaintenance")?.classList.toggle("active", main === "maintenance");

      document.getElementById("tabSubRegion")?.classList.toggle("active", activeImportSubTab === "region");
      document.getElementById("tabSubMap")?.classList.toggle("active", activeImportSubTab === "map");
      document.getElementById("tabSubHierarchy")?.classList.toggle("active", activeImportSubTab === "hierarchy");

      document.getElementById("panelSubRegion")?.classList.toggle("active", activeImportSubTab === "region");
      document.getElementById("panelSubMap")?.classList.toggle("active", activeImportSubTab === "map");
      document.getElementById("panelSubHierarchy")?.classList.toggle("active", activeImportSubTab === "hierarchy");

      document.getElementById("fietsklim-app-root")?.classList.toggle("wide", main === "import" && activeImportSubTab === "map");

      const panelImport = document.getElementById("panelImport");
      const panelClean = document.getElementById("panelClean");
      const panelMaintenance = document.getElementById("panelMaintenance");
      if (panelImport) panelImport.inert = main !== "import";
      if (panelClean) panelClean.inert = main !== "clean";
      if (panelMaintenance) panelMaintenance.inert = main !== "maintenance";

      if (main === "import" && activeImportSubTab === "map") {
        regionPicker?.onMapTabShown();
        setTimeout(() => document.getElementById("mapRegionSearch")?.focus({ preventScroll: true }), 50);
      } else {
        regionPicker?.invalidateSize();
      }

      if (main === "clean" && !duplicatesLoaded && window.FietsKlimDuplicateAdmin?.refreshReport) {
        duplicatesLoaded = true;
        void window.FietsKlimDuplicateAdmin.refreshReport();
      }
      if (main === "import" && activeImportSubTab === "hierarchy" && !hierarchyInited && window.FietsKlimRegionHierarchy) {
        hierarchyInited = true;
        void window.FietsKlimRegionHierarchy.init({
          onPickImport: (id) => pickRegionForImport(id),
          onPickMacroBatch: (macroId, ctx) => void importAreaForLocality(macroId, ctx),
          publishedByLocality: () => publishedByLocality || {},
          importStatus: typeof FietsKlimImportStatus !== "undefined" ? FietsKlimImportStatus : undefined,
        });
      }
    }

    document.getElementById("tabImport")?.addEventListener("click", () => setTab("import"));
    document.getElementById("tabClean")?.addEventListener("click", () => setTab("clean"));
    document.getElementById("tabMaintenance")?.addEventListener("click", () => setTab("maintenance"));
    document.getElementById("tabSubRegion")?.addEventListener("click", () => setTab("import", "region"));
    document.getElementById("tabSubMap")?.addEventListener("click", () => setTab("import", "map"));
    document.getElementById("tabSubHierarchy")?.addEventListener("click", () => setTab("import", "hierarchy"));

    document.getElementById("backfillRegionsBtn")?.addEventListener("click", async () => {
      if (!isUnlocked()) {
        log("FOUT: eerst inloggen.");
        return;
      }
      if (
        !confirm(
          "Alle gepubliceerde klimmen opnieuw herlabelen?\n\n" +
            "region = weergave (grootste sub-land uit ranking-cache, anders CF-naam/Overig).\n" +
            "resolved_locality_id = kleinste locality (dedupe).\n\n" +
            "Commit op main via GitHub Actions. Doorgaan?"
        )
      ) {
        return;
      }
      const btn = document.getElementById("backfillRegionsBtn");
      btn.disabled = true;
      try {
        await callGithubWorkflow("requestClimbRegionBackfill", {}, "Herlabel klimmen", "backfill-climb-regions.yml");
      } catch (e) {
        const msg = formatCallableError(e);
        log("FOUT: " + msg);
        if (/not-found|404|UNIMPLEMENTED/i.test(msg)) {
          log("");
          log("Tip: deploy Firebase Functions opnieuw (inclusief requestClimbRegionBackfill).");
          log("GitHub → Actions → Deploy Climbfinder import function → Run workflow.");
        }
      } finally {
        btn.disabled = false;
      }
    });

    async function dispatchMaintenanceCallable(callableName, payload, { confirmText, actionsPath, label }) {
      if (!isUnlocked()) {
        log("FOUT: eerst inloggen.");
        return;
      }
      if (confirmText && !confirm(confirmText)) {
        return;
      }
      await callGithubWorkflow(callableName, payload || {}, label || callableName, actionsPath);
    }

    let cfScoresPickerCtx = { countryIso: "", allCountry: false, bundleFile: "" };

    document.getElementById("splitMonolithBtn")?.addEventListener("click", async () => {
      const bundle = (document.getElementById("splitMonolithRegion")?.value || "").trim();
      if (!bundle) {
        log("FOUT: kies een land-monolith in de lijst (of dit land is al gesplitst).");
        return;
      }
      const btn = document.getElementById("splitMonolithBtn");
      btn.disabled = true;
      try {
        await dispatchMaintenanceCallable(
          "requestSplitMonolithBundle",
          { bundle, geo_fallback: "true", remove_source: "true" },
          {
            confirmText:
              `Monolith ${bundle} opsplitsen naar subregio-bundles?\n\n` +
              "Geo-fallback voor slugs zonder index; daarna dedupe. Commit op main via Actions.",
            actionsPath: "split-monolith-bundle.yml",
            label: `Split monolith ${bundle}`,
          }
        );
      } catch (e) {
        log("FOUT: " + formatCallableError(e));
        if (/not-found|404|UNIMPLEMENTED/i.test(formatCallableError(e))) {
          log("Tip: deploy Functions opnieuw (requestSplitMonolithBundle).");
        }
      } finally {
        btn.disabled = false;
      }
    });

    function readCfScoresBatchInputs() {
      const countryIso = document.getElementById("cfScoresCountry")?.value || "";
      const regionVal = document.getElementById("cfScoresRegion")?.value || "";
      const bundle = regionVal && regionVal !== "__country__" ? regionVal : "";
      let batch = parseInt(document.getElementById("cfScoresBatchSize")?.value, 10);
      if (!Number.isFinite(batch) || batch < 50) batch = 500;
      if (batch > 3000) batch = 3000;
      let offset = parseInt(document.getElementById("cfScoresOffset")?.value, 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      return { bundle, country_iso: countryIso, limit: String(batch), offset: String(offset) };
    }

    async function startCfScoresBatch({ bumpOffset = false } = {}) {
      const { bundle, country_iso, limit, offset } = readCfScoresBatchInputs();
      const batchN = Number(limit);
      const scope =
        bundle ? `bundle ${bundle}` : country_iso ? `alle ontbrekende in ${country_iso}` : "alle ontbrekende (wereld)";
      const confirmText =
        `Climbfinder-scores batch starten?\n\n` +
        `• Scope: ${scope}\n` +
        `• Max ${batchN} klimmen deze run (offset ${offset})\n` +
        `• ~${Math.round(batchN * 0.5)}–${Math.round(batchN * 0.9)} min op GitHub\n` +
        `• Na afloop: opnieuw “Start score-batch” tot alles klaar is\n\nDoorgaan?`;
      await dispatchMaintenanceCallable(
        "requestClimbfinderScoreBackfill",
        { bundle, country_iso, limit, offset, refetch_all: "false" },
        {
          confirmText,
          actionsPath: "backfill-climbfinder-scores.yml",
          label: `CF-scores batch (${limit})`,
        }
      );
      if (bumpOffset) {
        const offEl = document.getElementById("cfScoresOffset");
        if (offEl) offEl.value = String(offset + batchN);
        log(`Offset voor volgende batch (refetch-modus): ${offset + batchN}`);
      } else {
        log("Tip: na deze run opnieuw Start score-batch (offset 0) — alleen ontbrekende klimmen blijven over.");
      }
    }

    document.getElementById("backfillCfScoresBtn")?.addEventListener("click", async () => {
      const btn = document.getElementById("backfillCfScoresBtn");
      btn.disabled = true;
      try {
        await startCfScoresBatch({ bumpOffset: false });
      } catch (e) {
        log("FOUT: " + formatCallableError(e));
        if (/not-found|404|UNIMPLEMENTED/i.test(formatCallableError(e))) {
          log("Tip: deploy Functions opnieuw (requestClimbfinderScoreBackfill + offset).");
        }
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("backfillCfScoresNextBtn")?.addEventListener("click", async () => {
      const btn = document.getElementById("backfillCfScoresNextBtn");
      btn.disabled = true;
      try {
        await startCfScoresBatch({ bumpOffset: false });
      } catch (e) {
        log("FOUT: " + formatCallableError(e));
      } finally {
        btn.disabled = false;
      }
    });

    function hideClimbSearchResults() {
      const el = document.getElementById("climbSearchResults");
      if (el) {
        el.innerHTML = "";
        el.hidden = true;
      }
    }

    async function ensureClimbSearchIndex() {
      if (climbSlugSearchIndex) return climbSlugSearchIndex;
      if (!climbSearchIndexLoading) {
        climbSearchIndexLoading = ClimbfinderBrowser.loadClimbSlugSearchIndex()
          .then((idx) => {
            climbSlugSearchIndex = idx;
            return idx;
          })
          .catch((e) => {
            climbSearchIndexLoading = null;
            throw e;
          });
      }
      return climbSearchIndexLoading;
    }

    function dedupeClimbMatchesBySlug(matches) {
      const bySlug = new Map();
      for (const m of matches) {
        const prev = bySlug.get(m.slug);
        if (!prev || (m.score ?? 0) > (prev.score ?? 0)) bySlug.set(m.slug, m);
      }
      return [...bySlug.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    function renderClimbSearchResults(matches) {
      const box = document.getElementById("climbSearchResults");
      if (!box) return;
      const list = dedupeClimbMatchesBySlug(matches);
      if (!list.length) {
        hideClimbSearchResults();
        return;
      }
      box.hidden = false;
      box.innerHTML = list
        .map((m) => {
          const region = m.region_name || `l=${m.locality_id}`;
          const country = m.country || "?";
          const multi =
            matches.filter((x) => x.slug === m.slug).length > 1
              ? ' <span class="muted">· meerdere regio’s</span>'
              : "";
          return `<button type="button" class="cf-search-hit" data-l="${m.locality_id}" data-slug="${String(m.slug).replace(/"/g, "&quot;")}">${m.label} <span class="muted">(${country} · ${m.slug}, l=${m.locality_id})</span>${multi}</button>`;
        })
        .join("");
      box.querySelectorAll(".cf-search-hit").forEach((btn) => {
        btn.addEventListener("click", () => {
          const slug = btn.getAttribute("data-slug");
          const match = matches.find((x) => x.slug === slug) || list.find((x) => x.slug === slug);
          if (match) applyClimbSearchPick(match);
        });
      });
    }

    async function applyClimbSearchPick(entry) {
      hideClimbSearchResults();
      const input = document.getElementById("climbNameSearch");
      if (input) input.value = entry.label;
      if (!regionsCatalog) {
        log("Wacht op regio-catalogus…");
        await initRegions();
      }
      if (typeof FietsKlimClimbLookup !== "undefined") {
        const idx = await ensureClimbSearchIndex();
        await FietsKlimClimbLookup.showFromSearchEntry(entry, idx);
        log(`Klim «${entry.label}» (${entry.slug}) — status, regio’s en kaart hierboven.`);
        return;
      }
      if (activeImportTab !== "import" || activeImportSubTab !== "map") setTab("import", "map");
      if (!regionPicker) await initRegionPicker();
      const ok = await regionPicker?.pickLocality(entry.locality_id);
      if (!ok) log(`FOUT: regio l=${entry.locality_id} niet in catalogus.`);
    }

    function bindClimbNameSearch() {
      const input = document.getElementById("climbNameSearch");
      if (!input || input.dataset.bound) return;
      input.dataset.bound = "1";

      input.addEventListener("keydown", async (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        const q = input.value.trim();
        if (q.length < 2) return;
        try {
          let idx = await ensureClimbSearchIndex();
          let matches = ClimbfinderBrowser.searchClimbsByName(q, { index: idx, limit: 18 });
          if (!matches.length && /climbfinder\.com|^\w[\w-]+$/i.test(q)) {
            const { slugs } = await ClimbfinderBrowser.resolveLinesToSlugs([q]);
            if (slugs.length) {
              const slug = slugs[0];
              matches = idx.entries.filter((e) => e.slug === slug).slice(0, 18);
              if (!matches.length) {
                await applyClimbSearchPick({
                  slug,
                  label: slug.replace(/-/g, " "),
                  locality_id: 0,
                  region_name: "",
                  country: "?",
                  country_iso: null,
                });
                return;
              }
            }
          }
          if (matches.length === 1) await applyClimbSearchPick(matches[0]);
          else renderClimbSearchResults(matches);
        } catch (e) {
          log("Klim-zoeken: " + e.message);
        }
      });

      let debounce = null;
      input.addEventListener("input", () => {
        clearTimeout(debounce);
        const q = input.value.trim();
        if (q.length < 2) {
          hideClimbSearchResults();
          return;
        }
        debounce = setTimeout(async () => {
          try {
            const idx = await ensureClimbSearchIndex();
            renderClimbSearchResults(
              ClimbfinderBrowser.searchClimbsByName(q, { index: idx, limit: 18 })
            );
          } catch (e) {
            log("Klim-zoeken: " + e.message);
            hideClimbSearchResults();
          }
        }, 180);
      });

      document.addEventListener("click", (ev) => {
        if (!ev.target.closest(".climb-search-block")) hideClimbSearchResults();
      });
    }

    function isUnlocked() {
      return (
        window.__FIETSKLIM_AUTH_READY === true ||
        document.body.classList.contains("fietsklim-unlocked")
      );
    }

    async function initRegions() {
      if (regionsBooted) return;
      regionsBooted = true;
      const countrySel = document.getElementById("countrySelect");
      try {
        if (typeof ClimbfinderBrowser === "undefined") {
          throw new Error("climbfinder-browser.js niet geladen");
        }
        regionsCatalog = await ClimbfinderBrowser.loadRegionsCatalog();
        try {
          regionPopularCounts = await ClimbfinderBrowser.loadRegionPopularCounts();
        } catch (e) {
          regionPopularCounts = null;
          log("Popular-tellingen niet geladen: " + e.message);
        }
        if (typeof FietsKlimImportStatus !== "undefined") {
          publishedByLocality = await FietsKlimImportStatus.loadPublishedByLocality();
          await FietsKlimImportStatus.loadLocalityOverlaps();
        }
        void refreshSiteDatabaseSummary();
      } catch (e) {
        regionsBooted = false;
        countrySel.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = `Fout: ${e.message}`;
        countrySel.appendChild(opt);
        log("FOUT regio’s: " + e.message);
        throw e;
      }
      countrySel.innerHTML = "";
      for (const block of regionsCatalog.countries) {
        const opt = document.createElement("option");
        opt.value = block.country;
        opt.textContent = `${block.country} (${block.regions.length})`;
        countrySel.appendChild(opt);
      }
      countrySel.addEventListener("change", () => {
        const prevRegion = document.getElementById("regionSelect").value;
        fillRegionSelect();
        const regionSel = document.getElementById("regionSelect");
        if (prevRegion && [...regionSel.options].some((o) => o.value === prevRegion)) {
          regionSel.value = prevRegion;
        }
        updateRankingMeta();
        if (activeImportTab === "import" && activeImportSubTab === "map") regionPicker?.onMapTabShown();
        else regionPicker?.refreshCountry();
      });
      document.getElementById("regionSelect").addEventListener("change", () => {
        updateRankingMeta();
        regionPicker?.syncFromDropdown();
      });
      fillRegionSelect();
      initRegionPicker();
    }

    async function initRegionPicker() {
      if (regionPicker || typeof ClimbfinderRegionPicker === "undefined") return;
      try {
        regionPicker = await ClimbfinderRegionPicker.init({
          mapId: "regionMap",
          countrySelectId: "countrySelect",
          regionSelectId: "regionSelect",
          searchId: "mapRegionSearch",
          searchResultsId: "mapSearchResults",
          legendId: "mapLegend",
          onRegionChosen: () => {
            if (activeImportTab === "import" && activeImportSubTab === "map") setTab("import", "region");
          },
        });
        regionPicker.setCatalog(regionsCatalog);
      } catch (e) {
        log("Kaart regio’s: " + e.message);
      }
    }

    function fillRegionSelect() {
      const country = document.getElementById("countrySelect").value;
      const block = regionsCatalog.countries.find((c) => c.country === country);
      const regionSel = document.getElementById("regionSelect");
      regionSel.innerHTML = "";
      regionSel.disabled = !block;
      selectedRegion = null;
      document.getElementById("rankingMeta").textContent = "";
      if (!block) return;
      for (const r of block.regions) {
        const opt = document.createElement("option");
        opt.value = String(r.id);
        opt.textContent = regionSelectLabel(r);
        opt._region = { ...r, country, country_iso: r.country_iso || null };
        regionSel.appendChild(opt);
      }
      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = "— kies op kaart of hier —";
      regionSel.insertBefore(emptyOpt, regionSel.firstChild);
      regionSel.disabled = false;
      updateRankingMeta();
    }

    async function updateRankingMeta() {
      const regionSel = document.getElementById("regionSelect");
      const opt = regionSel.selectedOptions[0];
      if (!opt || !opt.value || !opt._region) {
        selectedRegion = null;
        document.getElementById("rankingMeta").textContent = "";
        refreshGhCommand();
        refreshImportLimitHint();
        return;
      }
      selectedRegion = { ...opt._region };
      applySuggestedImportLimit(selectedRegion);
      const meta = document.getElementById("rankingMeta");
      meta.textContent = "Ranking-slugs laden…";
      try {
        const ranking = await ClimbfinderBrowser.loadPopularRankingSlugs(selectedRegion.id);
        let warn = "";
        const expectIso = selectedRegion.country_iso;
        if (expectIso && ranking.country_iso && expectIso !== ranking.country_iso) {
          warn = ` · <strong style="color:#b91c1c">ID l=${selectedRegion.id} hoort bij ${ranking.country_iso}, niet ${expectIso} — kies andere regio of ververs catalogus</strong>`;
        } else if (ranking.country_iso) {
          warn = ` · climbs: ${ranking.country_iso}`;
        }
        const cfTotal = cfPopularCount(selectedRegion.id);
        let pagesHint = "";
        if (cfTotal != null) {
          pagesHint = ` · <strong>Climbfinder Popular: ${cfTotal} klimmen</strong> (max downloadbaar met hoge limit)`;
        }
        if (selectedRegion.id === 280) {
          pagesHint +=
            ' · <strong>l=280</strong> = provincie Limburg (niet hetzelfde als Zuid-Limburg l=27).';
        } else if (cfTotal == null) {
          pagesHint +=
            " · Pas <strong>aantal klimmen</strong> hierboven aan. Lokale cache toont alleen p.1–2.";
        } else {
          pagesHint += " · Zet <strong>aantal klimmen</strong> tot max. Popular-telling hierboven.";
        }
        const overlapDetail =
          typeof FietsKlimImportStatus !== "undefined"
            ? FietsKlimImportStatus.formatOverlapDetailHtml(selectedRegion.id, publishedByLocality)
            : "";
        meta.innerHTML =
          `${ranking.count} slugs in lokale cache (Popular p.1–2) · bijgewerkt ${ranking.updated_at || "?"}${warn}${pagesHint} · <a href="${ranking.ranking_url}" target="_blank" rel="noopener">Climbfinder ranking</a>${overlapDetail}`;
      } catch (e) {
        meta.textContent = e.message;
      }
      refreshGhCommand();
      void refreshPrimaryImportUi();
    }

    async function runImport(slugs, meta) {
      document.getElementById("log").textContent = "";
      document.getElementById("downloadBtn").disabled = true;
      lastBundle = null;
      lastBundle = await ClimbfinderBrowser.importSlugs(slugs, meta, (p) => {
        if (p.status === "fetch") log(`[${p.i}/${p.total}] ${p.slug}…`);
        else if (p.status === "ok") log(`  ✓ ${p.slug}`);
        else if (p.status === "err") log(`  ✗ ${p.slug}: ${p.error}`);
        else if (p.status === "resolve") log(`Zoek slug: ${p.line}…`);
        else if (p.status === "resolve_err") log(`  ✗ ${p.line}: ${p.error}`);
      });
      log(`\nKlaar: ${lastBundle.climbs.length} klimmen, ${lastBundle.meta.import_errors.length} fouten.`);
      document.getElementById("downloadBtn").disabled = false;
    }

    document.getElementById("importClimbLimit")?.addEventListener("input", () => {
      importLimitUserEdited = true;
      refreshGhCommand();
    });
    document.getElementById("importClimbLimit")?.addEventListener("change", () => {
      importLimitUserEdited = true;
      refreshGhCommand();
    });

    document.getElementById("copyGhBtn").addEventListener("click", () => {
      const ta = document.getElementById("ghCmd");
      ta.select();
      navigator.clipboard?.writeText(ta.value);
      log("gh-commando gekopieerd.");
    });

    document.getElementById("startGithubBtn").addEventListener("click", () => {
      void triggerSmartImport();
    });

    document.getElementById("runRegionBtn").addEventListener("click", async () => {
      const btn = document.getElementById("runRegionBtn");
      if (!isUnlocked()) {
        log("FOUT: eerst inloggen.");
        return;
      }
      if (!selectedRegion) return;
      btn.disabled = true;
      try {
        const ranking = await ClimbfinderBrowser.loadPopularRankingSlugs(selectedRegion.id);
        if (!ranking.slugs?.length) throw new Error("Geen slugs in ranking-cache voor deze regio");
        log(`Regio ${selectedRegion.name}: ${ranking.slugs.length} slugs (Popular, ${ranking.pages} pag.)`);
        const cc = countryCode(selectedRegion);
        await runImport(ranking.slugs, {
          metaId: metaIdFromRegion(selectedRegion),
          title: selectedRegion.name,
          country: cc,
          regionLabel: selectedRegion.name,
          tags: ["climbfinder", "popular", `locality-${selectedRegion.id}`],
          source: {
            name: "climbfinder",
            import: "browser",
            locality_id: selectedRegion.id,
            sort: "popular",
            pages: ranking.pages,
            ranking_url: ranking.ranking_url,
          },
        });
      } catch (e) {
        log("FOUT: " + e.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("runManualBtn").addEventListener("click", async () => {
      const btn = document.getElementById("runManualBtn");
      if (!isUnlocked()) {
        log("FOUT: eerst inloggen.");
        return;
      }
      btn.disabled = true;
      try {
        const lines = document.getElementById("slugs").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        if (!lines.length) throw new Error("Geen slugs of URL’s ingevuld");

        log("Slugs controleren…");
        const { slugs, errors } = await ClimbfinderBrowser.resolveLinesToSlugs(lines, (p) => {
          if (p.status === "resolve_err") log(`  ✗ ${p.line}: ${p.error}`);
        });
        for (const e of errors) log(`  ✗ ${e}`);
        if (!slugs.length) throw new Error("Geen geldige slugs — gebruik Climbfinder-URL of exacte slug");

        await runImport(slugs, {
          metaId: "custom-import",
          title: "Climbfinder handmatige import",
          country: "XX",
          regionLabel: "Import",
          tags: ["climbfinder"],
        });
      } catch (e) {
        log("FOUT: " + e.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("downloadBtn").addEventListener("click", () => {
      if (!lastBundle) return;
      const name = (lastBundle.meta.id || "climbs") + ".json";
      const blob = new Blob([JSON.stringify(lastBundle, null, 2) + "\n"], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
    });

    function bootImportPage() {
      void refreshPrimaryImportUi();
      refreshImportLimitHint();
      if (typeof FietsKlimBundlePicker !== "undefined") {
        void FietsKlimBundlePicker.init({
          countrySelectId: "splitMonolithCountry",
          regionSelectId: "splitMonolithRegion",
          mode: "monolith",
          hintId: "splitMonolithHint",
        }).catch((e) => log("Monolith-lijst: " + e.message));
        void FietsKlimBundlePicker.init({
          countrySelectId: "cfScoresCountry",
          regionSelectId: "cfScoresRegion",
          mode: "scores",
          hintId: "cfScoresOffsetHint",
          onRegionChange(bundleFile, ctx) {
            cfScoresPickerCtx = {
              bundleFile,
              countryIso: ctx.countryIso || "",
              allCountry: !!ctx.allCountry,
            };
          },
        }).catch((e) => log("Score-bundlelijst: " + e.message));
      }
      bindClimbNameSearch();
      if (typeof FietsKlimClimbLookup !== "undefined") {
        FietsKlimClimbLookup.init({
          ensureSearchIndex: ensureClimbSearchIndex,
          loadPopularCounts: () => ClimbfinderBrowser.loadRegionPopularCounts(),
          getPublishedByLocality: () => publishedByLocality || {},
          log,
          pickLocalityOnMainMap,
          async startRegionImport(localityId) {
            if (!pickRegionForImport(localityId, { startGithub: true })) {
              log(`FOUT: regio l=${localityId} niet in catalogus.`);
            }
          },
          openManualImport(slug, label) {
            setTab("import", "region");
            const ta = document.getElementById("slugs");
            if (ta) ta.value = slug;
            log(`Handmatig: «${label}» (${slug}) — Start import (browser) of gebruik GitHub-regio-import.`);
          },
        });
      }
      initRegions().catch(() => {});
      if (typeof FietsKlimDuplicateAdminInit === "function") {
        FietsKlimDuplicateAdminInit({
          isUnlocked,
          githubImportConfig,
          log,
          formatCallableError,
          onWorkflowStarted: (label, data) => {
            if (typeof FietsKlimActivityFeed !== "undefined") {
              FietsKlimActivityFeed.trackDispatchResponse(label, data, log);
            }
          },
        });
      }
    }

    document.addEventListener("fietsklim-authenticated", () => bootImportPage());

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootImportPage);
    } else {
      bootImportPage();
    }

    /* Regio-JSON is publiek; herhaal als eerste fetch te vroeg was */
    let regionRetries = 0;
    const regionTimer = setInterval(() => {
      regionRetries += 1;
      if (regionsBooted && regionsCatalog) {
        clearInterval(regionTimer);
        return;
      }
      if (regionRetries > 24) {
        clearInterval(regionTimer);
        return;
      }
      bootImportPage();
    }, 500);
})();

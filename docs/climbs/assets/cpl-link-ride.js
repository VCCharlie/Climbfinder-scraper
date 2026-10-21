/**
 * Handmatig klim ↔ CPL-rit koppelen (cplListActivitiesForLink + cplLinkClimbOnActivity).
 */
(function (global) {
  const REGION = global.FIETSKLIM_AUTH_CONFIG?.functionsRegion || "europe-west1";

  let selectedActivityId = null;
  let selectedClimb = null;
  let listCursor = null;
  let climbSearchIndex = null;
  let fietsklimIndex = null;

  function $(id) {
    return document.getElementById(id);
  }

  function callable(name) {
    return firebase.app().functions(REGION).httpsCallable(name);
  }

  function setStatus(el, msg, isError) {
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("is-error", Boolean(isError));
  }

  function dateInputToEpochStart(isoDate) {
    if (!isoDate) return null;
    const t = Date.parse(`${isoDate}T00:00:00`);
    return Number.isFinite(t) ? t : null;
  }

  function dateInputToEpochEnd(isoDate) {
    if (!isoDate) return null;
    const t = Date.parse(`${isoDate}T23:59:59.999`);
    return Number.isFinite(t) ? t : null;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function resolveDataUrl(relativePath) {
    return new URL(relativePath, global.location.href).href;
  }

  async function ensureFietsklimIndex() {
    if (fietsklimIndex) return fietsklimIndex;
    const res = await fetch(resolveDataUrl("data/index.json"), { cache: "no-store" });
    if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
    fietsklimIndex = await res.json();
    return fietsklimIndex;
  }

  async function resolveClimbIdsFromSearchEntry(entry) {
    const index = await ensureFietsklimIndex();
    const slug = String(entry.slug || "").trim();
    const localityId = Number(entry.locality_id);
    const regions = index.regions || [];
    let region = regions.find((r) => Number(r.locality_id) === localityId);
    if (!region && slug) {
      region = regions.find((r) => String(r.id || "").includes(`l${localityId}-`));
    }
    if (!region?.url) {
      throw new Error("Regio voor deze klim niet in index.json — importeer de regio eerst.");
    }
    const bundleUrl = resolveDataUrl(region.url);
    const res = await fetch(bundleUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Regio-bundle HTTP ${res.status}`);
    const bundle = await res.json();
    const climbs = bundle.climbs || [];
    const climb = climbs.find((c) => {
      const s = c?.climbfinder?.slug || c?.slug;
      return s && String(s).toLowerCase() === slug.toLowerCase();
    });
    if (!climb?.id) {
      throw new Error(`Klim «${slug}» niet in dataset ${region.id} (Popular-index ≠ volledige regio).`);
    }
    return {
      datasetId: region.id,
      climbId: String(climb.id),
      climbName: climb.name || entry.label || slug,
      regionTitle: region.displayTitle || region.title,
    };
  }

  function renderActivityList(items, append) {
    const ul = $("cplLinkRideActivityList");
    if (!ul) return;
    if (!append) ul.innerHTML = "";
    if (!items.length && !append) {
      ul.innerHTML = '<li class="cpl-link-ride-list-empty">Geen ritten in dit bereik.</li>';
      return;
    }
    for (const a of items) {
      const li = document.createElement("li");
      li.className = "cpl-link-ride-list-item";
      const id = escapeHtml(a.id);
      const checked = selectedActivityId === a.id ? " checked" : "";
      const route = a.hasRoute ? "route" : "geen route";
      const meta = `${escapeHtml(a.date || "?")} · ${route} · match ${a.engineHitCount || 0} · handmatig ${a.userLinkCount || 0}`;
      li.innerHTML = `
        <label class="cpl-link-ride-radio">
          <input type="radio" name="cplActivity" value="${id}"${checked} />
          <span class="cpl-link-ride-radio-title">${escapeHtml(a.title)}</span>
          <span class="cpl-link-ride-radio-meta">${meta}</span>
        </label>`;
      ul.appendChild(li);
    }
    ul.querySelectorAll('input[name="cplActivity"]').forEach((input) => {
      input.addEventListener("change", () => {
        selectedActivityId = input.value;
        updateSummary();
      });
    });
  }

  async function loadCplStatus() {
    const el = $("cplLinkRideCplStatus");
    try {
      const res = await callable("getCplStatus")({});
      const d = res.data || {};
      if (d.linked) {
        setStatus(el, "Performance Lab: gekoppeld", false);
      } else {
        setStatus(el, d.linkHint || "Performance Lab: niet gekoppeld", true);
      }
      return Boolean(d.linked);
    } catch (e) {
      setStatus(el, "Performance Lab: status niet geladen", true);
      return false;
    }
  }

  async function loadActivities(append) {
    const statusEl = $("cplLinkRideListStatus");
    const moreBtn = $("cplLinkRideMoreBtn");
    if (!(await loadCplStatus())) {
      setStatus(statusEl, "Koppel eerst CPL (zelfde Google-account).", true);
      return;
    }
    setStatus(statusEl, "Ritten laden…", false);
    const payload = {
      after: dateInputToEpochStart($("cplLinkRideAfter")?.value),
      before: dateInputToEpochEnd($("cplLinkRideBefore")?.value),
      pageSize: 35,
    };
    if (append && listCursor) payload.cursor = listCursor;
    else listCursor = null;

    try {
      const res = await callable("cplListActivitiesForLink")(payload);
      const data = res.data || {};
      listCursor = data.cursor || null;
      renderActivityList(data.activities || [], append);
      const n = (data.activities || []).length;
      setStatus(statusEl, `${n} rit(ten) in deze batch${data.completed ? " (klaar)" : ""}.`, false);
      if (moreBtn) moreBtn.hidden = Boolean(data.completed || !listCursor);
    } catch (e) {
      setStatus(statusEl, e.message || String(e), true);
      if (moreBtn) moreBtn.hidden = true;
    }
  }

  function hideClimbResults() {
    const box = $("cplLinkRideClimbResults");
    if (box) {
      box.innerHTML = "";
      box.hidden = true;
    }
  }

  function renderClimbResults(matches) {
    const box = $("cplLinkRideClimbResults");
    if (!box) return;
    if (!matches.length) {
      hideClimbResults();
      return;
    }
    box.hidden = false;
    box.innerHTML = matches
      .map((m) => {
        const region = m.region_name || `l=${m.locality_id}`;
        const country = m.country || "?";
        return `<li role="option" tabindex="0" data-slug="${escapeHtml(m.slug)}" data-locality="${m.locality_id}" data-label="${escapeHtml(m.label)}">
          <span class="climb-search-suggest-name">${escapeHtml(m.label)}</span>
          <span class="climb-search-suggest-meta">${escapeHtml(region)} · ${escapeHtml(country)}</span>
        </li>`;
      })
      .join("");
    box.querySelectorAll("li[role=option]").forEach((li) => {
      li.addEventListener("click", () => void pickClimbFromLi(li));
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") void pickClimbFromLi(li);
      });
    });
  }

  async function pickClimbFromLi(li) {
    const entry = {
      slug: li.getAttribute("data-slug"),
      locality_id: Number(li.getAttribute("data-locality")),
      label: li.getAttribute("data-label"),
    };
    hideClimbResults();
    const pickEl = $("cplLinkRideClimbPick");
    setStatus(pickEl, "Klim-ID opzoeken…", false);
    pickEl.hidden = false;
    try {
      const resolved = await resolveClimbIdsFromSearchEntry(entry);
      selectedClimb = resolved;
      setStatus(
        pickEl,
        `Geselecteerd: ${resolved.climbName} (${resolved.datasetId} / ${resolved.climbId})`,
        false
      );
      updateSummary();
    } catch (e) {
      selectedClimb = null;
      setStatus(pickEl, e.message || String(e), true);
      updateSummary();
    }
  }

  async function ensureClimbIndex() {
    if (climbSearchIndex) return climbSearchIndex;
    if (typeof ClimbfinderBrowser === "undefined") {
      throw new Error("ClimbfinderBrowser niet geladen.");
    }
    climbSearchIndex = await ClimbfinderBrowser.loadClimbSlugSearchIndex();
    return climbSearchIndex;
  }

  function bindClimbSearch() {
    const input = $("cplLinkRideClimbSearch");
    if (!input || input.dataset.bound) return;
    input.dataset.bound = "1";
    let debounce = null;
    input.addEventListener("input", () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 2) {
        hideClimbResults();
        return;
      }
      debounce = setTimeout(async () => {
        try {
          const idx = await ensureClimbIndex();
          const matches = ClimbfinderBrowser.searchClimbsByName(q, { index: idx, limit: 16 });
          renderClimbResults(matches);
        } catch (e) {
          hideClimbResults();
        }
      }, 200);
    });
    input.addEventListener("keydown", async (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const q = input.value.trim();
      if (q.length < 2) return;
      try {
        const idx = await ensureClimbIndex();
        let matches = ClimbfinderBrowser.searchClimbsByName(q, { index: idx, limit: 16 });
        if (matches.length === 1) {
          const li = document.createElement("li");
          li.setAttribute("data-slug", matches[0].slug);
          li.setAttribute("data-locality", String(matches[0].locality_id));
          li.setAttribute("data-label", matches[0].label);
          await pickClimbFromLi(li);
        } else {
          renderClimbResults(matches);
        }
      } catch (e) {
        setStatus($("cplLinkRideClimbPick"), e.message || String(e), true);
      }
    });
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest(".cpl-link-ride-search")) hideClimbResults();
    });
  }

  function updateSummary() {
    const btn = $("cplLinkRideSubmitBtn");
    const summary = $("cplLinkRideSummary");
    const ready = Boolean(selectedActivityId && selectedClimb);
    if (btn) btn.disabled = !ready;
    if (!summary) return;
    if (!ready) {
      summary.textContent = "Selecteer een rit en een klim.";
      return;
    }
    summary.textContent = `Rit ${selectedActivityId} → ${selectedClimb.climbName}`;
  }

  async function submitLink() {
    const resultEl = $("cplLinkRideResult");
    const btn = $("cplLinkRideSubmitBtn");
    if (!selectedActivityId || !selectedClimb) return;
    if (btn) btn.disabled = true;
    setStatus(resultEl, "Koppelen…", false);
    try {
      const res = await callable("cplLinkClimbOnActivity")({
        cplActivityId: selectedActivityId,
        datasetId: selectedClimb.datasetId,
        climbId: selectedClimb.climbId,
        climbName: selectedClimb.climbName,
      });
      const d = res.data || {};
      setStatus(
        resultEl,
        d.ok
          ? `Gelukt: journal bijgewerkt (${d.journalEntries || 0} regel(s)). Zie logboek.`
          : "Onbekend antwoord.",
        false
      );
      global.dispatchEvent(new CustomEvent("fietsklim-climb-log-changed"));
      await loadActivities(false);
    } catch (e) {
      setStatus(resultEl, e.message || String(e), true);
    } finally {
      if (btn) btn.disabled = !selectedActivityId || !selectedClimb;
    }
  }

  function bind() {
    $("cplLinkRideLoadBtn")?.addEventListener("click", () => void loadActivities(false));
    $("cplLinkRideMoreBtn")?.addEventListener("click", () => void loadActivities(true));
    $("cplLinkRideSubmitBtn")?.addEventListener("click", () => void submitLink());
    bindClimbSearch();
  }

  function whenUnlocked(fn) {
    if (global.__FIETSKLIM_AUTH_READY || document.body.classList.contains("fietsklim-unlocked")) {
      fn();
      return;
    }
    global.addEventListener("fietsklim-auth-ready", fn, { once: true });
  }

  whenUnlocked(() => {
    bind();
    void loadCplStatus();
  });
})(window);

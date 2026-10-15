/**
 * Optional: trigger .github/workflows/climbfinder-import.yml from the import page.
 * Deploy: see docs/auth/GITHUB_IMPORT.md
 *
 * Secrets (firebase functions:config:set):
 *   github.pat — fine-grained PAT with Actions: write on this repo
 *   github.repo — owner/name (default VCCharlie/Climbfinder-scraper)
 *   github.ref — branch to run on (default main)
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const DEFAULT_ALLOWED = ["vr.deruiter@gmail.com"];
const WORKFLOW_IMPORT = "climbfinder-import.yml";
const WORKFLOW_DEDUPE = "remove-duplicate-climbs.yml";
const WORKFLOW_DEDUPE_ALL = "dedupe-all-smallest-region.yml";
const WORKFLOW_BACKFILL_REGIONS = "backfill-climb-regions.yml";
const WORKFLOW_MACRO_BATCH = "macro-klimgebied-import-batch.yml";
const WORKFLOW_SPLIT_MONOLITH = "split-monolith-bundle.yml";
const WORKFLOW_BACKFILL_CF_SCORES = "backfill-climbfinder-scores.yml";

function allowedEmail(email) {
  const cfg = functions.config().auth || {};
  const list = (cfg.allowed_emails || DEFAULT_ALLOWED.join(",")).split(",").map((s) => s.trim().toLowerCase());
  return email && list.includes(email.trim().toLowerCase());
}

function assertImportCaller(context) {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }
}

function githubConfig() {
  const gh = functions.config().github || {};
  const pat = gh.pat;
  if (!pat) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "GitHub PAT niet geconfigureerd op Firebase Functions. Zie docs/auth/GITHUB_IMPORT.md"
    );
  }
  const repo = gh.repo || "VCCharlie/Climbfinder-scraper";
  const ref = gh.ref || "main";
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new functions.https.HttpsError("internal", "github.repo moet owner/name zijn.");
  }
  return { pat, repo, ref, owner, name };
}

function dispatchResult(owner, name, workflowFile, message) {
  return {
    ok: true,
    message,
    workflowFile,
    dispatchedAtMs: Date.now(),
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/${workflowFile}`,
  };
}

async function githubFetch(pat, url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body };
}

/** Poll status van een workflow-run (voor importpagina activity feed). */
exports.getGithubWorkflowRunStatus = functions.region("europe-west1").https.onCall(async (data, context) => {
  assertImportCaller(context);
  const { pat, owner, name } = githubConfig();

  const workflowFile = String(data.workflow_file || "").trim();
  const runId = data.run_id != null && data.run_id !== "" ? Number(data.run_id) : null;
  const sinceMs = data.since_ms != null && data.since_ms !== "" ? Number(data.since_ms) : null;

  if (!workflowFile && !runId) {
    throw new functions.https.HttpsError("invalid-argument", "workflow_file of run_id is verplicht.");
  }

  if (runId && Number.isFinite(runId)) {
    const { ok, status, body } = await githubFetch(
      pat,
      `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}`
    );
    if (!ok) {
      functions.logger.error("GitHub run fetch failed", status, body);
      throw new functions.https.HttpsError("internal", `GitHub run ophalen mislukt (${status}).`);
    }
    return formatRunPayload(body);
  }

  const { ok, status, body } = await githubFetch(
    pat,
    `https://api.github.com/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=15`
  );
  if (!ok) {
    functions.logger.error("GitHub workflow runs failed", status, body);
    throw new functions.https.HttpsError("internal", `GitHub workflow-runs ophalen mislukt (${status}).`);
  }

  const runs = body?.workflow_runs || [];
  let pick = runs[0] || null;
  if (sinceMs && Number.isFinite(sinceMs)) {
    const floor = sinceMs - 120_000;
    pick =
      runs.find((r) => {
        const t = Date.parse(r.created_at || "");
        return Number.isFinite(t) && t >= floor;
      }) || pick;
  }

  if (!pick) {
    return {
      found: false,
      workflow_file: workflowFile,
      status: "queued",
      display_status: "Wachten op run…",
    };
  }

  return { found: true, workflow_file: workflowFile, ...formatRunPayload(pick) };
});

function formatRunPayload(run) {
  const st = run.status || "unknown";
  const conclusion = run.conclusion || null;
  let display_status = st;
  if (st === "completed") {
    if (conclusion === "success") display_status = "Geslaagd";
    else if (conclusion === "failure") display_status = "Mislukt";
    else if (conclusion === "cancelled") display_status = "Geannuleerd";
    else display_status = conclusion || "Afgerond";
  } else if (st === "in_progress") display_status = "Bezig…";
  else if (st === "queued") display_status = "In wachtrij…";
  else if (st === "waiting") display_status = "Wacht op runner…";

  return {
    run_id: run.id,
    status: st,
    conclusion,
    display_status,
    html_url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
    name: run.name,
  };
}

exports.requestClimbfinderImport = functions.region("europe-west1").https.onCall(async (data, context) => {
  assertImportCaller(context);
  const { pat, ref, owner, name } = githubConfig();

  const locality = String(data.locality || "").trim();
  const metaId = String(data.meta_id || "").trim();
  const title = String(data.title || "").trim();
  const country = String(data.country || "").trim();
  const regionLabel = String(data.region_label || "").trim();
  const pages = String(data.pages != null ? data.pages : 2);
  const limit = String(data.limit != null ? data.limit : 50);

  if (!locality || !metaId || !title || !country || !regionLabel) {
    throw new functions.https.HttpsError("invalid-argument", "locality, meta_id, title, country, region_label zijn verplicht.");
  }

  const url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${WORKFLOW_IMPORT}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        locality,
        pages,
        meta_id: metaId,
        title,
        country,
        region_label: regionLabel,
        limit,
        publish_to_site: String(data.publish_to_site != null ? data.publish_to_site : "true"),
        merge_into: String(data.merge_into || ""),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    functions.logger.error("GitHub dispatch failed", res.status, text);
    throw new functions.https.HttpsError("internal", `GitHub Actions start mislukt (${res.status}).`);
  }

  const publish = String(data.publish_to_site != null ? data.publish_to_site : "true") !== "false";
  return dispatchResult(
    owner,
    name,
    WORKFLOW_IMPORT,
    publish
      ? "Import gestart (gebied of enkele regio). JSON komt op de kaart na de run."
      : "Import gestart. Download JSON bij Artifacts wanneer de run klaar is."
  );
});

exports.requestClimbDuplicateRemovals = functions.region("europe-west1").https.onCall(async (data, context) => {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }

  const gh = functions.config().github || {};
  const pat = gh.pat;
  if (!pat) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "GitHub PAT niet geconfigureerd op Firebase Functions. Zie docs/auth/GITHUB_IMPORT.md"
    );
  }

  const removals = data.removals;
  if (!Array.isArray(removals) || !removals.length) {
    throw new functions.https.HttpsError("invalid-argument", "removals moet een niet-lege array zijn.");
  }
  if (removals.length > 150) {
    throw new functions.https.HttpsError("invalid-argument", "Max. 150 verwijderingen per run.");
  }
  for (const row of removals) {
    if (!row || typeof row !== "object" || !String(row.dataset_id || "").trim() || !String(row.climb_id || "").trim()) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Elke removal: { dataset_id, climb_id }."
      );
    }
  }

  const repo = gh.repo || "VCCharlie/Climbfinder-scraper";
  const ref = gh.ref || "main";
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new functions.https.HttpsError("internal", "github.repo moet owner/name zijn.");
  }

  const url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${WORKFLOW_DEDUPE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        removals_json: JSON.stringify(removals),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    functions.logger.error("GitHub dedupe dispatch failed", res.status, text);
    throw new functions.https.HttpsError("internal", `GitHub Actions start mislukt (${res.status}).`);
  }

  return dispatchResult(
    owner,
    name,
    WORKFLOW_DEDUPE,
    `Verwijder-workflow gestart (${removals.length} kopieën). Na ~1–3 min: hard refresh import/kaart.`
  );
});

exports.requestClimbDedupeAllSmallest = functions.region("europe-west1").https.onCall(async (_data, context) => {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }

  const gh = functions.config().github || {};
  const pat = gh.pat;
  if (!pat) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "GitHub PAT niet geconfigureerd op Firebase Functions. Zie docs/auth/GITHUB_IMPORT.md"
    );
  }

  const repo = gh.repo || "VCCharlie/Climbfinder-scraper";
  const ref = gh.ref || "main";
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new functions.https.HttpsError("internal", "github.repo moet owner/name zijn.");
  }

  const url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${WORKFLOW_DEDUPE_ALL}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref, inputs: {} }),
  });

  if (!res.ok) {
    const text = await res.text();
    functions.logger.error("GitHub dedupe-all dispatch failed", res.status, text);
    throw new functions.https.HttpsError("internal", `GitHub Actions start mislukt (${res.status}).`);
  }

  return dispatchResult(
    owner,
    name,
    WORKFLOW_DEDUPE_ALL,
    "Volledige dedupe gestart (behoud kleinste dataset per slug). Duurt enkele minuten — daarna hard refresh."
  );
});

exports.requestClimbRegionBackfill = functions.region("europe-west1").https.onCall(async (_data, context) => {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }

  const gh = functions.config().github || {};
  const pat = gh.pat;
  if (!pat) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "GitHub PAT niet geconfigureerd op Firebase Functions. Zie docs/auth/GITHUB_IMPORT.md"
    );
  }

  const repo = gh.repo || "VCCharlie/Climbfinder-scraper";
  const ref = gh.ref || "main";
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new functions.https.HttpsError("internal", "github.repo moet owner/name zijn.");
  }

  const url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${WORKFLOW_BACKFILL_REGIONS}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref, inputs: {} }),
  });

  if (!res.ok) {
    const text = await res.text();
    functions.logger.error("GitHub backfill regions dispatch failed", res.status, text);
    throw new functions.https.HttpsError("internal", `GitHub Actions start mislukt (${res.status}).`);
  }

  return dispatchResult(
    owner,
    name,
    WORKFLOW_BACKFILL_REGIONS,
    "Backfill gestart: herlabel region (weergave) + display/resolved locality op alle klimmen. Duurt enkele minuten."
  );
});

async function dispatchWorkflow(pat, repo, ref, workflowFile, inputs) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new functions.https.HttpsError("internal", "github.repo moet owner/name zijn.");
  }
  const url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref, inputs }),
  });
  if (!res.ok) {
    const text = await res.text();
    functions.logger.error(`GitHub dispatch failed ${workflowFile}`, res.status, text);
    throw new functions.https.HttpsError("internal", `GitHub Actions start mislukt (${res.status}).`);
  }
  return { owner, name };
}

exports.requestSplitMonolithBundle = functions.region("europe-west1").https.onCall(async (data, context) => {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }

  const gh = functions.config().github || {};
  const pat = gh.pat;
  if (!pat) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "GitHub PAT niet geconfigureerd op Firebase Functions. Zie docs/auth/GITHUB_IMPORT.md"
    );
  }

  const repo = gh.repo || "VCCharlie/Climbfinder-scraper";
  const ref = gh.ref || "main";
  const bundle = String(data.bundle || "cf-l45-switzerland.json").trim() || "cf-l45-switzerland.json";
  const geoFallback = String(data.geo_fallback != null ? data.geo_fallback : "true");
  const removeSource = String(data.remove_source != null ? data.remove_source : "true");

  const { owner, name } = await dispatchWorkflow(pat, repo, ref, WORKFLOW_SPLIT_MONOLITH, {
    bundle,
    geo_fallback: geoFallback,
    remove_source: removeSource,
  });

  return dispatchResult(
    owner,
    name,
    WORKFLOW_SPLIT_MONOLITH,
    `Monolith-split gestart voor ${bundle} (geo=${geoFallback}, remove=${removeSource}).`
  );
});

exports.requestClimbfinderScoreBackfill = functions.region("europe-west1").https.onCall(async (data, context) => {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }

  const gh = functions.config().github || {};
  const pat = gh.pat;
  if (!pat) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "GitHub PAT niet geconfigureerd op Firebase Functions. Zie docs/auth/GITHUB_IMPORT.md"
    );
  }

  const repo = gh.repo || "VCCharlie/Climbfinder-scraper";
  const ref = gh.ref || "main";
  const bundle = String(data.bundle || "").trim();
  const countryIso = String(data.country_iso || "").trim();
  const limit = String(data.limit != null ? data.limit : "500");
  const offset = String(data.offset != null ? data.offset : "0");
  const refetchAll = String(data.refetch_all != null ? data.refetch_all : "false");

  const { owner, name } = await dispatchWorkflow(pat, repo, ref, WORKFLOW_BACKFILL_CF_SCORES, {
    bundle,
    country_iso: countryIso,
    limit,
    offset,
    refetch_all: refetchAll,
  });

  const limNote = limit === "0" ? "geen limiet (lang!)" : `max ${limit} klimmen`;
  const offNote = offset !== "0" ? `, offset ${offset}` : "";
  return dispatchResult(
    owner,
    name,
    WORKFLOW_BACKFILL_CF_SCORES,
    `Climbfinder-scores batch gestart (${limNote}${offNote}). Herhaal tot de queue leeg is.`
  );
});

exports.requestClimbMacroBatchImport = functions.region("europe-west1").https.onCall(async (data, context) => {
  if (!context.auth?.token?.email) {
    throw new functions.https.HttpsError("unauthenticated", "Log in met Google.");
  }
  if (!allowedEmail(context.auth.token.email)) {
    throw new functions.https.HttpsError("permission-denied", "Geen toegang.");
  }

  const gh = functions.config().github || {};
  const pat = gh.pat;
  if (!pat) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "GitHub PAT niet geconfigureerd op Firebase Functions. Zie docs/auth/GITHUB_IMPORT.md"
    );
  }

  const macroId = String(data.macro_locality_id || "").trim();
  if (!macroId) {
    throw new functions.https.HttpsError("invalid-argument", "macro_locality_id is verplicht.");
  }

  const repo = gh.repo || "VCCharlie/Climbfinder-scraper";
  const ref = gh.ref || "main";
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new functions.https.HttpsError("internal", "github.repo moet owner/name zijn.");
  }

  const countryIso = String(data.country_iso || "").trim();
  const skipDedupe = String(data.skip_dedupe != null ? data.skip_dedupe : "false");

  const url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${WORKFLOW_MACRO_BATCH}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        macro_locality_id: macroId,
        country_iso: countryIso,
        skip_dedupe: skipDedupe,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    functions.logger.error("GitHub macro batch dispatch failed", res.status, text);
    throw new functions.https.HttpsError("internal", `GitHub Actions start mislukt (${res.status}).`);
  }

  return dispatchResult(
    owner,
    name,
    WORKFLOW_MACRO_BATCH,
    `Macro-batch import gestart (l=${macroId}). Alle niet-● subregio’s, pages=all; dedupe aan het eind.`
  );
});

Object.assign(exports, require("./strava"));
Object.assign(exports, require("./cplSync"));

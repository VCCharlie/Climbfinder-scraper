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

function allowedEmail(email) {
  const cfg = functions.config().auth || {};
  const list = (cfg.allowed_emails || DEFAULT_ALLOWED.join(",")).split(",").map((s) => s.trim().toLowerCase());
  return email && list.includes(email.trim().toLowerCase());
}

exports.requestClimbfinderImport = functions.region("europe-west1").https.onCall(async (data, context) => {
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
  return {
    ok: true,
    message: publish
      ? "Import gestart op GitHub Actions. Bij publish_to_site=true komt JSON automatisch op de kaart na de run."
      : "Import gestart. Download JSON bij Artifacts wanneer de run klaar is.",
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/${WORKFLOW_IMPORT}`,
  };
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

  return {
    ok: true,
    message: `Verwijder-workflow gestart (${removals.length} kopieën). Na ~1–3 min: hard refresh import/kaart.`,
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/${WORKFLOW_DEDUPE}`,
  };
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

  return {
    ok: true,
    message:
      "Volledige dedupe gestart (behoud kleinste dataset per slug). Duurt enkele minuten — daarna hard refresh.",
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/${WORKFLOW_DEDUPE_ALL}`,
  };
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

  return {
    ok: true,
    message:
      "Backfill gestart: herlabel region (weergave) + display/resolved locality op alle klimmen. Duurt enkele minuten.",
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/${WORKFLOW_BACKFILL_REGIONS}`,
  };
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

  return {
    ok: true,
    message: `Macro-batch import gestart (l=${macroId}). Alle niet-● subregio’s, pages=all; dedupe aan het eind.`,
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/${WORKFLOW_MACRO_BATCH}`,
  };
});

Object.assign(exports, require("./strava"));

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
const WORKFLOW_FILE = "climbfinder-import.yml";

function allowedEmail(email) {
  const cfg = functions.config().auth || {};
  const list = (cfg.allowed_emails || DEFAULT_ALLOWED.join(",")).split(",").map((s) => s.trim().toLowerCase());
  return email && list.includes(email.trim().toLowerCase());
}

exports.requestClimbfinderImport = functions.https.onCall(async (data, context) => {
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

  const url = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
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

  return {
    ok: true,
    message: "Import gestart op GitHub Actions. Download JSON bij Artifacts wanneer de run klaar is.",
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/${WORKFLOW_FILE}`,
  };
});

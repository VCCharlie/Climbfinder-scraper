/**
 * Handmatige klim-koppelingen op CPL-activiteiten (rit-niveau).
 * Portable — kopieer naar Climb Performance Lab repo.
 */
const USER_LINKS_SCHEMA_VERSION = 1;

function normalizeUserLink(raw) {
  if (!raw || typeof raw !== "object") return null;
  const datasetId = String(raw.datasetId || "").trim();
  const climbId = String(raw.climbId || "").trim();
  if (!datasetId || !climbId) return null;
  return {
    datasetId,
    climbId,
    climbName: raw.climbName != null ? String(raw.climbName) : null,
    linked_at: raw.linked_at || raw.linkedAt || null,
    note: raw.note != null ? String(raw.note) : null,
    engine_status:
      raw.engine_status === "confirmed" ||
      raw.engine_status === "weak" ||
      raw.engine_status === "unverified"
        ? raw.engine_status
        : raw.engineStatus === "confirmed" ||
            raw.engineStatus === "weak" ||
            raw.engineStatus === "unverified"
          ? raw.engineStatus
          : "unverified",
  };
}

function userLinksFromActivityData(data) {
  const raw = data?.fietsklim_user_links;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUserLink).filter(Boolean);
}

function buildUserLink({ datasetId, climbId, climbName, note }) {
  return {
    datasetId: String(datasetId),
    climbId: String(climbId),
    climbName: climbName != null ? String(climbName) : null,
    linked_at: new Date().toISOString(),
    note: note != null ? String(note) : null,
    engine_status: "unverified",
  };
}

module.exports = {
  USER_LINKS_SCHEMA_VERSION,
  normalizeUserLink,
  userLinksFromActivityData,
  buildUserLink,
};

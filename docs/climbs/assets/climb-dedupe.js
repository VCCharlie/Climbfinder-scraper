/** Globale dedupe-sleutel voor klimmen (Climbfinder slug, anders id). */
(function (global) {
  function climbGlobalKey(climb) {
    if (!climb) return null;
    const slug = climb.climbfinder?.slug;
    if (slug) return `slug:${slug}`;
    if (climb.id) return `id:${climb.id}`;
    return null;
  }

  global.FietsKlimClimbDedupe = { climbGlobalKey };
})(typeof window !== "undefined" ? window : globalThis);

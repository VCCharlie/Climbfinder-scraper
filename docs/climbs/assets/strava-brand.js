/** Strava-logomark — altijd hetzelfde bestand als in de statische HTML (assets/strava-logomark.svg). */
(function (global) {
  const MARK_SRC = "assets/strava-logomark.svg";

  function stravaMarkSvg(options = {}) {
    const { className = "logbook-strava-mark-svg", width = 14, height = 14 } = options;
    return `<img src="${MARK_SRC}" alt="" class="${className}" width="${width}" height="${height}" decoding="async" />`;
  }

  global.FietsKlimStravaBrand = {
    stravaMarkSvg,
  };
})(typeof window !== "undefined" ? window : globalThis);

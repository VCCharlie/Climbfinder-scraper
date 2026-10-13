/** Strava-logomark (twee chevrons) — gedeeld door logboek en overige UI. */
(function (global) {
  const MARK_PATHS = `<path fill="#FC4C02" d="M39.1 7.6 55.7 40H44l-4.7-9.2L32 43.9l-7.3-13.1-4.7 9.2H12.3L28.9 7.6H32l7.1 0z"/><path fill="#FDB08E" d="M55.7 40H44l-4.7-9.2 9 17.9 7.4-8.7z"/>`;

  function stravaMarkSvg(options = {}) {
    const { className = "logbook-strava-mark-svg", width = 14, height = 14 } = options;
    return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${width}" height="${height}" aria-hidden="true">${MARK_PATHS}</svg>`;
  }

  global.FietsKlimStravaBrand = {
    stravaMarkSvg,
  };
})(typeof window !== "undefined" ? window : globalThis);

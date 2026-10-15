/**
 * Fetch Intervals.icu route polyline and encode as Google summary polyline (strava_map compatible).
 */

import { fetchWithTimeout } from './fetchWithTimeout.js';
import { devLog } from './safeLog.js';

function encodeSigned(num) {
    let s = num << 1;
    if (num < 0) s = ~s;
    let out = '';
    while (s >= 0x20) {
        out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
        s >>= 5;
    }
    out += String.fromCharCode(s + 63);
    return out;
}

/**
 * @param {Array<[number, number]>|Array<{lat:number,lng:number}>} latLngs
 * @returns {string|null}
 */
export function encodeGooglePolyline(latLngs) {
    if (!latLngs?.length) return null;
    let lastLat = 0;
    let lastLon = 0;
    let result = '';
    for (const pt of latLngs) {
        const lat = Array.isArray(pt) ? Number(pt[0]) : Number(pt.lat);
        const lon = Array.isArray(pt) ? Number(pt[1]) : Number(pt.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const latE5 = Math.round(lat * 1e5);
        const lonE5 = Math.round(lon * 1e5);
        result += encodeSigned(latE5 - lastLat);
        result += encodeSigned(lonE5 - lastLon);
        lastLat = latE5;
        lastLon = lonE5;
    }
    return result || null;
}

function normalizeLatLngPayload(json) {
    if (!json) return null;
    if (Array.isArray(json)) {
        if (!json.length) return null;
        if (Array.isArray(json[0])) return json;
        if (json[0]?.lat != null && json[0]?.lng != null) return json.map((p) => [p.lat, p.lng]);
    }
    const latlngs = json.latlngs || json.latlng || json.data;
    if (Array.isArray(latlngs) && latlngs.length) return latlngs;
    return null;
}

/**
 * @param {string} activityId — Intervals activity id (incl. leading i)
 * @param {{ apiKey?: string }} intervalsConfig
 * @returns {Promise<string|null>} encoded polyline
 */
export async function fetchIntervalsActivityMapPolyline(activityId, intervalsConfig) {
    const id = String(activityId || '').trim();
    if (!id || !intervalsConfig?.apiKey) return null;

    const authString = btoa(`API_KEY:${intervalsConfig.apiKey}`);
    const headers = {
        Authorization: `Basic ${authString}`,
        Accept: 'application/json',
    };

    const mapUrl = `https://intervals.icu/api/v1/activity/${encodeURIComponent(id)}/map`;
    try {
        const resp = await fetchWithTimeout(mapUrl, { method: 'GET', headers });
        if (resp.ok) {
            const json = await resp.json();
            const latlngs = normalizeLatLngPayload(json);
            const encoded = encodeGooglePolyline(latlngs);
            if (encoded) return encoded;
        } else {
            devLog(`[Intervals map] ${id}: HTTP ${resp.status}`);
        }
    } catch (err) {
        devLog(`[Intervals map] ${id}: ${err?.message || err}`);
    }

    const streamUrl = `https://intervals.icu/api/v1/activity/${encodeURIComponent(id)}/streams?types=latlng`;
    try {
        const resp = await fetchWithTimeout(streamUrl, { method: 'GET', headers });
        if (!resp.ok) return null;
        const json = await resp.json();
        const stream = Array.isArray(json) ? json.find((s) => s.type === 'latlng') : json?.latlng;
        const data = stream?.data || stream?.latlng || stream;
        const latlngs = normalizeLatLngPayload(data);
        return encodeGooglePolyline(latlngs);
    } catch (err) {
        devLog(`[Intervals map streams] ${id}: ${err?.message || err}`);
        return null;
    }
}

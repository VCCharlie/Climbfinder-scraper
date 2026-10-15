/**
 * Backfill intervals_map on activities that have no Strava summary polyline yet.
 */

import { stripUndefinedFields } from './mergeActivities.js';
import { fetchIntervalsActivityMapPolyline } from './intervalsMapFetch.js';

function needsRouteMap(act) {
    if (!act?.id) return false;
    const stravaMap = act.strava_map != null && String(act.strava_map).trim() !== '';
    if (stravaMap) return false;
    const intervalsMap = act.intervals_map != null && String(act.intervals_map).trim() !== '';
    return !intervalsMap;
}

/**
 * @param {object} activity
 * @param {{ apiKey?: string }} intervalsConfig
 */
export async function enrichActivityMapFromIntervals(activity, intervalsConfig) {
    if (!needsRouteMap(activity) || !intervalsConfig?.apiKey) {
        return stripUndefinedFields({ ...activity });
    }
    const poly = await fetchIntervalsActivityMapPolyline(String(activity.id), intervalsConfig);
    if (!poly) return stripUndefinedFields({ ...activity });
    return stripUndefinedFields({ ...activity, intervals_map: poly });
}

/**
 * @param {object[]} siteActivities
 * @param {{ apiKey?: string }} intervalsConfig
 * @param {{ concurrency?: number, onProgress?: (msg: string) => void }} [opts]
 */
export async function buildIntervalsMapEnrichmentUpdates(siteActivities, intervalsConfig, opts = {}) {
    const conc = Math.max(1, Math.min(4, opts.concurrency ?? 2));
    const list = (siteActivities || []).filter(needsRouteMap);
    if (!intervalsConfig?.apiKey || list.length === 0) {
        return { updates: [], ridesProcessed: 0, unchanged: 0, failed: 0 };
    }

    opts.onProgress?.(`Intervals route map: ${list.length} ride(s)…`);

    const updates = [];
    let unchanged = 0;
    let failed = 0;
    let idx = 0;

    async function worker() {
        while (idx < list.length) {
            const i = idx;
            idx += 1;
            const act = list[i];
            try {
                const enriched = await enrichActivityMapFromIntervals(act, intervalsConfig);
                const poly = enriched.intervals_map;
                if (!poly || String(act.intervals_map || '') === String(poly)) {
                    unchanged += 1;
                    continue;
                }
                updates.push({ id: act.id, data: { intervals_map: poly } });
            } catch {
                failed += 1;
            }
            if (opts.delayMs) {
                await new Promise((r) => setTimeout(r, opts.delayMs));
            }
        }
    }

    const workers = Array.from({ length: conc }, () => worker());
    await Promise.all(workers);

    return {
        updates,
        ridesProcessed: list.length,
        unchanged,
        failed,
    };
}

/**
 * Voorkomt dat Intervals.icu (of andere) sync lege / generieke waarden
 * over bestaande handmatige of Strava-verrijkte velden heen schrijft bij merge: true.
 */

import { normalizeStravaActivityId } from './strava.js';
import { getAllDriftMergeKeys } from './coach/driftMergeKeys.js';
import {
    protectClimbingOnMerge,
    protectStravaLinkedGearOnMerge,
    protectStravaLinkedTitleOnMerge,
    protectStravaLinkedTypeOnMerge,
    protectZoneTimesFieldsOnMerge,
} from './activityFieldRetention.js';
import { protectActivityTagsOnMerge } from './activityTags.js';

const GENERIC_TITLE = /^(Morning|Lunch|Afternoon|Evening|Night) Ride$|^Untitled$/i;

const isGenericTitle = (t) => {
    const s = (t || '').trim();
    return !s || GENERIC_TITLE.test(s);
};

const isSpecificTitle = (t) => {
    const s = (t || '').trim();
    return !!s && !GENERIC_TITLE.test(s);
};

const hasStravaId = (v) => {
    const n = normalizeStravaActivityId(v);
    return !!(n && n.length >= 6);
};

const METRIC_RETENTION_KEYS = [
    'avg_power',
    'norm_power',
    'load',
    'work',
    'max_power',
    'best_1min',
    'best_5min',
    'best_10min',
    'best_20min',
    'best_60min',
    'best_90min',
    'best_120min',
    'best_150min',
    'best_180min',
];

function retainPositiveMetricIfIncomingEmpty(incoming, existing, out, key) {
    const inVal = Number(incoming[key]);
    const exVal = Number(existing[key]);
    const incomingMissing = !Number.isFinite(inVal) || inVal <= 0;
    const existingPresent = Number.isFinite(exVal) && exVal > 0;
    if (incomingMissing && existingPresent) {
        out[key] = existing[key];
    }
}

function protectPowerMetricsOnMerge(incoming, existing, out) {
    for (const key of METRIC_RETENTION_KEYS) {
        retainPositiveMetricIfIncomingEmpty(incoming, existing, out, key);
    }
}

/**
 * @param {object} incoming - Activiteit die we naar Firestore willen schrijven
 * @param {object|undefined|null} existing - Huidige activiteit uit app-state (zelfde id), indien bekend
 * @param {{ deviceProfileTitles?: string[], dataSourcePrefs?: import('./syncDataSourcePrefs.js').SyncDataSourcePrefs }} [opts]
 * @returns {object} Payload voor setDoc(..., { merge: true })
 */
export function protectEnrichedFieldsOnMerge(incoming, existing, opts = {}) {
    if (!incoming || typeof incoming !== 'object') return incoming;
    const out = { ...incoming };

    if (!existing || typeof existing !== 'object') return out;

    const inRpe = Number(incoming.rpe);
    const exRpe = Number(existing.rpe);
    if ((!inRpe || inRpe === 0) && exRpe > 0) {
        out.rpe = existing.rpe;
    }

    const inTitle = (incoming.title || '').trim();
    const exTitle = (existing.title || '').trim();

    if (isSpecificTitle(exTitle) && isGenericTitle(inTitle)) {
        out.title = existing.title;
    }
    protectStravaLinkedTitleOnMerge(incoming, existing, out, opts);

    // Strava link + route + gear: Intervals payload often omits these; never wipe enriched data.
    if (hasStravaId(existing.strava_id) && !hasStravaId(incoming.strava_id)) {
        out.strava_id = existing.strava_id;
    }
    const inMap = incoming.strava_map != null && String(incoming.strava_map).trim() !== '';
    const exMap = existing.strava_map != null && String(existing.strava_map).trim() !== '';
    if (exMap && !inMap) {
        out.strava_map = existing.strava_map;
    }
    const inIntervalsMap =
        incoming.intervals_map != null && String(incoming.intervals_map).trim() !== '';
    const exIntervalsMap =
        existing.intervals_map != null && String(existing.intervals_map).trim() !== '';
    if (exIntervalsMap && !inIntervalsMap) {
        out.intervals_map = existing.intervals_map;
    }
    protectStravaLinkedGearOnMerge(incoming, existing, out, opts);
    if (opts.dataSourcePrefs?.gearAndType !== 'intervals') {
        if (existing.gear_id && !incoming.gear_id && out.gear_id !== existing.gear_id) {
            out.gear_id = existing.gear_id;
        }
        const exGearName = existing.gear_name != null && String(existing.gear_name).trim() !== '';
        const inGearName = incoming.gear_name != null && String(incoming.gear_name).trim() !== '';
        if (exGearName && !inGearName && out.gear_name !== existing.gear_name) {
            out.gear_name = existing.gear_name;
        }
    }
    protectStravaLinkedTypeOnMerge(incoming, existing, out, opts);

    const inHr = Number(incoming.avg_hr);
    const exHr = Number(existing.avg_hr);
    if ((!inHr || inHr === 0) && exHr > 0) {
        out.avg_hr = existing.avg_hr;
    }
    const inMx = Number(incoming.max_hr);
    const exMx = Number(existing.max_hr);
    if ((!inMx || inMx === 0) && exMx > 0) {
        out.max_hr = existing.max_hr;
    }

    const exKom = existing.strava_kom_summary;
    const inKom = incoming.strava_kom_summary;
    const exKomLabel = exKom && typeof exKom === 'object' && String(exKom.label || '').trim();
    const inKomLabel = inKom && typeof inKom === 'object' && String(inKom.label || '').trim();
    if (exKomLabel && !inKomLabel) {
        out.strava_kom_summary = existing.strava_kom_summary;
    }

    protectClimbingOnMerge(incoming, existing, out, opts);
    protectZoneTimesFieldsOnMerge(incoming, existing, out);
    protectActivityTagsOnMerge(incoming, existing, out);
    protectPowerMetricsOnMerge(incoming, existing, out);

    // Stream-based drift summaries: preserve when re-sync omits enriched fields.
    const driftKeys = getAllDriftMergeKeys();
    const driftPctKeys = new Set(['decoupling_pct', 'threshold_drift_pct', 'race_drift_pct']);
    for (const key of driftKeys) {
        const incomingVal = incoming[key];
        const existingVal = existing[key];
        const incomingMissing = incomingVal == null
            || incomingVal === ''
            || (driftPctKeys.has(key) && !Number.isFinite(Number(incomingVal)));
        const existingPresent = existingVal != null
            && existingVal !== ''
            && (!driftPctKeys.has(key) || Number.isFinite(Number(existingVal)));
        if (incomingMissing && existingPresent) {
            out[key] = existing[key];
        }
    }

    return out;
}

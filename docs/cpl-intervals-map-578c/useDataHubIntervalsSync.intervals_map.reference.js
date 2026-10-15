import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { db } from '../firebase';
import { SPORT_TYPES } from '../config';
import { defaultSportFilterMap } from '../utils/nightlySyncDefaults.js';
import { formatIntervalsImportHealthParts } from '../utils/intervalsImportHealth.js';
import { protectEnrichedFieldsOnMerge } from '../utils/firestoreActivityMerge';
import { batchWriteDocuments } from '../utils/firestoreBatchWrite';
import { buildActivityFirestoreMergePayload } from '../utils/activityFirestoreWrite.js';
import { resolveOwnerUid } from '../utils/activityOwnership.js';
import { stripUndefinedFields } from '../utils/mergeActivities';
import { enrichSelectedActivitiesFromStrava } from '../utils/stravaSelectedEnrich';
import useIntervalsSync from './useIntervalsSync';
import { buildMergeProtectOpts } from '../utils/mergeProtectOptions.js';
import { useToast } from '../context/ToastContext';
import { safeLocalStorageSet } from '../utils/safeStorage';
import { ACTIVITY_LOG_INTERVALS_LAST_SYNC_KEY, readLastIntervalsSyncAt } from '../utils/activityLogSyncLabel';
import { countMergeCategories, formatIntervalsSyncSummary, formatStravaGapFillSummaryParts } from '../utils/importSyncStats';
import { enrichSyncedActivitiesDrift, formatSyncDriftRemainderNote } from '../utils/syncDriftEnrich';
import { resolveSyncEnrichLimits } from '../utils/syncEnrichLimits.js';
import { buildPostImportActivityList } from '../utils/postImportActivityList';
import { runIntervalsSyncWithStravaGapFill } from '../utils/runIntervalsSyncWithStravaGapFill';
import {
    readIntervalsSyncHealthSummary,
    writeIntervalsSyncHealthSummary,
} from '../utils/intervalsSyncHealth';
import {
    buildStravaSyncMatchSummary,
    formatStravaSyncMatchSummary,
} from '../utils/stravaSyncMatchSummary';
import { buildDefaultSyncDates } from '../utils/syncDateRange';
import { backfillStravaMetricsForSparseIntervalsActivities } from '../utils/intervalsStravaApiRestriction';
import { buildIntervalsMapEnrichmentUpdates } from '../utils/intervalsMapEnrich.js';
import {
    isFullSyncDepth,
    readPersistedSyncDepth,
    writePersistedSyncDepth,
    normalizeSyncDepth,
    resolveInitialSyncDepth,
} from '../utils/intervalsSyncDepth.js';

/**
 * Intervals.icu sync + fetch-new flows for DataHub (selected-row sync and date-range fetch).
 */
function buildActivitiesLookupMap(activities, getActivitiesSnapshot) {
    const source = typeof getActivitiesSnapshot === 'function'
        ? getActivitiesSnapshot()
        : activities;
    return new Map((source || []).map((a) => [String(a.id), a]));
}

async function persistActivitiesMerge(activities, existingMap, mergeOpts = {}, ownerUid = null) {
    if (!db || !activities?.length) return;
    const uid = resolveOwnerUid(ownerUid);
    await batchWriteDocuments(
        'activities',
        activities.map((act) => {
            const existing = existingMap.get(String(act.id));
            return {
                id: act.id,
                data: buildActivityFirestoreMergePayload(act, existing, mergeOpts, uid),
            };
        }),
    );
}

async function persistActivityUpdates(updates, existingMap, mergeOpts = {}, ownerUid = null) {
    if (!db || !updates?.length) return;
    const uid = resolveOwnerUid(ownerUid);
    await batchWriteDocuments(
        'activities',
        updates.map(({ id, data }) => {
            const strId = String(id);
            const existingRow = existingMap.get(strId) || {};
            return {
                id,
                data: buildActivityFirestoreMergePayload(data, existingRow, mergeOpts, uid),
            };
        }),
    );
}

export function useDataHubIntervalsSync({
    intervalsConfig,
    activities,
    onImport,
    stravaGetToken,
    bulkSelectedIds,
    selectedActivitiesForBulk,
    userSettings,
    getActivitiesSnapshot,
    onImportFinished,
}) {
    const mergeProtectOpts = useMemo(
        () => buildMergeProtectOpts(userSettings),
        [userSettings?.bikeComputerProfileTitles, userSettings?.syncDataSourcePrefs],
    );
    const deviceProfileTitles = mergeProtectOpts.deviceProfileTitles;
    const { showToast } = useToast();

    const applyIntervalsMapEnrichmentToList = useCallback(async (list, activitiesMap, onProgress) => {
        if (!intervalsConfig?.apiKey || !list?.length) return list;
        const mapResult = await buildIntervalsMapEnrichmentUpdates(list, intervalsConfig, {
            concurrency: 2,
            delayMs: 120,
            onProgress,
        });
        if (!mapResult.updates?.length) return list;
        if (db) {
            await persistActivityUpdates(
                mapResult.updates,
                activitiesMap,
                mergeProtectOpts,
                resolveOwnerUid(),
            );
        }
        const updatesMap = new Map(mapResult.updates.map((u) => [String(u.id), u.data]));
        return list.map((act) => {
            const patch = updatesMap.get(String(act.id));
            if (!patch) return act;
            const existingBase = activitiesMap.get(String(act.id)) || act;
            return protectEnrichedFieldsOnMerge(
                stripUndefinedFields({ ...act, ...patch }),
                existingBase,
                mergeProtectOpts,
            );
        });
    }, [intervalsConfig, mergeProtectOpts]);

    const recordIntervalsSyncSuccess = useCallback((healthSummary) => {
        const now = new Date().toISOString();
        safeLocalStorageSet(ACTIVITY_LOG_INTERVALS_LAST_SYNC_KEY, now);
        setLastIntervalsSyncAt(now);
        if (healthSummary) {
            const stamped = { ...healthSummary, at: now };
            writeIntervalsSyncHealthSummary(stamped);
            setLastSyncHealthSummary(stamped);
        }
    }, []);
    const { syncIntervals, isSyncing, syncProgress } = useIntervalsSync(intervalsConfig);
    const [syncStatus, setSyncStatus] = useState(null);
    const [syncErrorDetail, setSyncErrorDetail] = useState(null);
    const [lastIntervalsSyncAt, setLastIntervalsSyncAt] = useState(() => readLastIntervalsSyncAt());
    const [lastSyncHealthSummary, setLastSyncHealthSummary] = useState(() => readIntervalsSyncHealthSummary());
    const defaultSyncRangeDays = Number(userSettings?.defaultSyncRangeDays) > 0
        ? Math.round(Number(userSettings.defaultSyncRangeDays))
        : 14;
    const [syncDates, setSyncDates] = useState(() => buildDefaultSyncDates(defaultSyncRangeDays));
    const [syncMode, setSyncMode] = useState('fetch-range');
    const [sportFilters, setSportFilters] = useState(() => defaultSportFilterMap());
    const [isFetchingNewIntervals, setIsFetchingNewIntervals] = useState(false);
    const [stravaEnrichEnabled, setStravaEnrichEnabled] = useState(true);
    const settingsSyncDepth = normalizeSyncDepth(userSettings?.defaultIntervalsSyncDepth);
    const [syncDepth, setSyncDepthState] = useState(() => resolveInitialSyncDepth(userSettings));
    const prevSettingsSyncDepthRef = useRef(settingsSyncDepth);

    useEffect(() => {
        const next = settingsSyncDepth;
        if (prevSettingsSyncDepthRef.current === next) return;
        prevSettingsSyncDepthRef.current = next;
        setSyncDepthState(next);
        writePersistedSyncDepth(next);
    }, [settingsSyncDepth]);

    const setSyncDepth = useCallback((depth) => {
        const normalized = normalizeSyncDepth(depth);
        setSyncDepthState(normalized);
        writePersistedSyncDepth(normalized);
    }, []);

    const getSelectedSportTypes = useCallback(
        () => Object.keys(sportFilters).filter((k) => sportFilters[k]),
        [sportFilters],
    );

    const syncEnrichLimits = useMemo(
        () => resolveSyncEnrichLimits(userSettings),
        [userSettings?.syncEnrichLimits],
    );

    const buildSyncEnrichOptions = useCallback(async () => {
        const profileFtp = Number(userSettings?.ftp) || 0;
        let stravaToken = null;
        if (stravaEnrichEnabled && stravaGetToken) {
            try {
                stravaToken = await stravaGetToken();
            } catch {
                stravaToken = null;
            }
        }
        const limits = resolveSyncEnrichLimits(userSettings);
        return {
            profileFtp,
            stravaToken,
            intervalsConfig,
            deferDriftEnrich: true,
            enrichmentMode: isFullSyncDepth(syncDepth) ? 'full' : 'fast',
            zoneTimesMaxFetches: limits.zoneTimesMaxFetches,
            powerCurveMaxFetches: limits.powerCurveMaxFetches,
            driftMaxFetches: limits.driftMaxFetches,
            driftMaxFetchesToday: limits.driftMaxFetchesToday,
        };
    }, [userSettings, stravaEnrichEnabled, stravaGetToken, intervalsConfig, syncDepth]);

    const applyPostSyncDriftEnrich = useCallback(async (list, activitiesMap, enrichOptions, driftOptions = {}) => {
        if (!list?.length || Number(enrichOptions.profileFtp) <= 0) {
            return { list, driftEnrichedCount: 0, driftRemainingCount: 0 };
        }

        setSyncStatus('enriching');
        setSyncErrorDetail('Analyzing HR drift from power+HR streams…');

        let stravaToken = enrichOptions.stravaToken;
        if (!stravaToken && stravaEnrichEnabled && stravaGetToken) {
            try {
                stravaToken = await stravaGetToken();
            } catch {
                stravaToken = null;
            }
        }

        const { activities: driftOut, enrichedCount, remainingCount } = await enrichSyncedActivitiesDrift(list, {
            intervalsConfig,
            stravaToken,
            profileFtp: enrichOptions.profileFtp,
            maxFetches: driftOptions.maxFetches ?? enrichOptions.driftMaxFetches ?? syncEnrichLimits.driftMaxFetches,
            onProgress: (message) => setSyncErrorDetail(String(message)),
        });

        if (enrichedCount <= 0) {
            return { list, driftEnrichedCount: 0, driftRemainingCount: remainingCount };
        }

        const updated = driftOut.map((act) => {
            const existing = activitiesMap.get(String(act.id));
            return existing ? protectEnrichedFieldsOnMerge(act, existing, mergeProtectOpts) : act;
        });

        if (db) {
            await persistActivitiesMerge(updated, activitiesMap, mergeProtectOpts, resolveOwnerUid());
        }
        onImport(updated);

        return { list: updated, driftEnrichedCount: enrichedCount, driftRemainingCount: remainingCount };
    }, [intervalsConfig, stravaEnrichEnabled, stravaGetToken, onImport, mergeProtectOpts, syncEnrichLimits.driftMaxFetches]);

    const persistImportedActivities = useCallback(async (items, activitiesMap) => {
        if (!items?.length) return;
        await persistActivitiesMerge(items, activitiesMap, mergeProtectOpts, resolveOwnerUid());
    }, [mergeProtectOpts]);

    const applyStravaGapFillToBatch = useCallback(async ({
        intervalsBatch,
        syncStart,
        syncEnd,
        selectedTypes,
        onProgress,
    }) => {
        if (!isFullSyncDepth(syncDepth)) {
            return {
                intervalsActivities: intervalsBatch,
                orphanActivities: [],
                stravaList: null,
                stats: null,
            };
        }
        if (!stravaEnrichEnabled || !stravaGetToken) {
            return { intervalsActivities: intervalsBatch, orphanActivities: [], stravaList: null, stats: null };
        }
        try {
            const token = await stravaGetToken();
            if (!token) {
                return { intervalsActivities: intervalsBatch, orphanActivities: [], stravaList: null, stats: null };
            }
            const existingSnapshot = typeof getActivitiesSnapshot === 'function'
                ? getActivitiesSnapshot()
                : activities;
            return runIntervalsSyncWithStravaGapFill({
                intervalsActivities: intervalsBatch,
                existingActivities: existingSnapshot,
                stravaToken: token,
                startYmd: syncStart,
                endYmd: syncEnd,
                allowedSportTypes: selectedTypes,
                opts: { onProgress, deviceProfileTitles, intervalsConfig },
            });
        } catch (err) {
            console.warn('[Sync] Strava gap fill failed:', err);
            return { intervalsActivities: intervalsBatch, orphanActivities: [], stravaList: null, stats: null };
        }
    }, [activities, getActivitiesSnapshot, stravaEnrichEnabled, stravaGetToken, deviceProfileTitles, intervalsConfig, syncDepth]);

    const toggleSportFilter = useCallback((type) => {
        setSportFilters((prev) => ({ ...prev, [type]: !prev[type] }));
    }, []);

    const setAllSportFilters = useCallback((val) => {
        setSportFilters(SPORT_TYPES.reduce((acc, type) => ({ ...acc, [type]: val }), {}));
    }, []);

    const handleSync = useCallback(async (overrideBulkIds, overrideSelectedActs) => {
        const selectedIdSet = overrideBulkIds ?? bulkSelectedIds;
        const selectedActs = overrideSelectedActs ?? selectedActivitiesForBulk;

        if (selectedIdSet.size === 0) {
            setSyncStatus('error');
            setSyncErrorDetail('Select one or more activities (checkboxes), then use Refresh selected in the Intervals.icu sync panel.');
            setTimeout(() => setSyncStatus(null), 7000);
            return;
        }

        const selectedActsList = selectedActs;
        const dateParts = selectedActsList
            .reduce((acc, a) => {
                const dp = (a?.date && String(a.date).split('T')[0]) || '';
                if (dp) acc.push(dp);
                return acc;
            }, [])
            .sort();
        if (dateParts.length === 0) {
            setSyncStatus('error');
            setSyncErrorDetail('Selected activities have no valid date; cannot determine Intervals.icu range.');
            setTimeout(() => setSyncStatus(null), 7000);
            return;
        }

        const syncStart = dateParts[0];
        const syncEnd = dateParts[dateParts.length - 1];
        const bulkIdSet = new Set([...selectedIdSet].map(String));

        let working = selectedActsList.map((a) => ({ ...a }));

        setSyncStatus('started');
        setSyncErrorDetail(`Step 1/2: Intervals.icu ${syncStart} → ${syncEnd} (${selectedIdSet.size} selected)…`);

        try {
            const selectedTypes = getSelectedSportTypes();
            if (selectedTypes.length === 0) {
                setSyncStatus('error');
                setSyncErrorDetail('Select at least one sport type to sync.');
                showToast('Select at least one sport type to sync.', { variant: 'warning' });
                setTimeout(() => setSyncStatus(null), 7000);
                return;
            }

            const enrichOptions = await buildSyncEnrichOptions();
            const syncResult = await syncIntervals(syncStart, syncEnd, selectedTypes, enrichOptions);
            const syncStats = syncResult.stats;
            const newActivitiesRaw = syncResult.activities || [];
            const newActivities = newActivitiesRaw.filter((a) => bulkIdSet.has(String(a.id)));

            const activitiesMap = buildActivitiesLookupMap(activities, getActivitiesSnapshot);

            const mergeNewInto = (act) => {
                const existing = activitiesMap.get(String(act.id));
                return existing ? protectEnrichedFieldsOnMerge(act, existing, mergeProtectOpts) : act;
            };

            setSyncErrorDetail(
                newActivities.length < newActivitiesRaw.length
                    ? `Step 2/3: Strava link + gap fill (${newActivities.length} of ${newActivitiesRaw.length} selected)…`
                    : `Step 2/3: Strava link + gap fill for ${selectedIdSet.size} selected ride(s)…`,
            );
            setSyncStatus('enriching');

            const gapResult = await applyStravaGapFillToBatch({
                intervalsBatch: newActivitiesRaw,
                syncStart,
                syncEnd,
                selectedTypes,
                activitiesMap,
                onProgress: (m) => setSyncErrorDetail(String(m)),
            });
            const gapIntervalsById = new Map(
                (gapResult.intervalsActivities || []).map((a) => [String(a.id), a]),
            );
            const mergedNews = newActivities.map((act) => mergeNewInto(
                gapIntervalsById.get(String(act.id)) || act,
            ));
            const orphanMerged = (gapResult.orphanActivities || []).map(mergeNewInto);
            const allPersisted = [...mergedNews, ...orphanMerged];

            await persistImportedActivities(allPersisted, activitiesMap);
            if (allPersisted.length > 0) {
                onImport(allPersisted);
            }

            const workingIndexMap = new Map();
            for (let i = 0; i < working.length; i++) {
                workingIndexMap.set(String(working[i].id), i);
            }

            for (const n of mergedNews) {
                const i = workingIndexMap.get(String(n.id));
                if (i !== undefined) {
                    working[i] = protectEnrichedFieldsOnMerge({ ...working[i], ...n }, working[i], mergeProtectOpts);
                }
            }

            if (!isFullSyncDepth(syncDepth)) {
                const skippedEmpty = Number(syncStats?.skippedEmpty) || 0;
                recordIntervalsSyncSuccess({
                    added: orphanMerged.length,
                    updated: mergedNews.length,
                    skipped: skippedEmpty,
                    importHealth: syncStats?.health,
                    syncRoute: syncStats?.syncRoute,
                    syncDepth: syncDepth,
                });
                onImportFinished?.(buildPostImportActivityList(activities, [...working, ...orphanMerged]));

                setSyncStatus('done');
                const parts = [];
                if (mergedNews.length > 0) parts.push(`${mergedNews.length} Intervals row(s) saved`);
                if (skippedEmpty > 0) parts.push(`${skippedEmpty} skipped (no distance/time/power)`);
                parts.push(...formatIntervalsImportHealthParts(syncStats?.health));
                if (syncStats?.syncRoute === 'direct') parts.push('route: direct API');
                else if (syncStats?.syncRoute === 'cloud') parts.push('route: cloud sync');
                parts.push('Fast sync (Intervals only — no Strava/drift)');
                setSyncErrorDetail(`✅ Sync complete. ${parts.join(' · ')}.`);
                showToast(`Sync complete. ${parts.join(' · ')}.`, { variant: 'success' });
                setTimeout(() => setSyncStatus(null), 9000);
                return;
            }

            if (stravaEnrichEnabled && stravaGetToken) {
                setSyncErrorDetail('Step 2b/3: Strava metrics for Intervals-restricted rides…');
                working = await backfillStravaMetricsForSparseIntervalsActivities(working, {
                    stravaGetToken,
                    stravaToken: enrichOptions.stravaToken,
                    intervalsConfig,
                    onProgress: (m) => setSyncErrorDetail(String(m)),
                });
                if (working.some((a) => bulkIdSet.has(String(a.id)))) {
                    const backfillPersist = working.filter((a) => bulkIdSet.has(String(a.id)));
                    await persistImportedActivities(backfillPersist, activitiesMap);
                    onImport(backfillPersist);
                }
            }

            setSyncErrorDetail('Step 3/3: Strava detail enrich for selected rides…');

            let enrichedLinkCount = 0;
            let segmentRefreshCount = 0;
            let detailFailed = 0;
            let stravaEnrichWarning = null;
            if (stravaEnrichEnabled && stravaGetToken) {
                try {
                    const token = await stravaGetToken();
                    if (token) {
                        const enrichResult = await enrichSelectedActivitiesFromStrava(working, token, {
                            forceStravaDetail: true,
                            concurrency: 3,
                            deviceProfileTitles,
                            dataSourcePrefs: mergeProtectOpts.dataSourcePrefs,
                            onProgress: (m) => setSyncErrorDetail(String(m)),
                        });
                        enrichedLinkCount = enrichResult.linkedCount;
                        segmentRefreshCount = enrichResult.detailUpdatedCount;
                        detailFailed = enrichResult.failed;
                        if (enrichResult.updates.length > 0) {
                            const workingMap = new Map((working || []).map((a) => [String(a.id), a]));
                            if (db) {
                                await persistActivityUpdates(
                                    enrichResult.updates,
                                    new Map([...workingMap, ...activitiesMap]),
                                    mergeProtectOpts,
                                    resolveOwnerUid(),
                                );
                            }
                            const updatesMap = new Map(enrichResult.updates.map((u) => [String(u.id), u]));
                            for (let i = 0; i < working.length; i++) {
                                const strId = String(working[i].id);
                                const update = updatesMap.get(strId);
                                if (update) {
                                    const existingBase = activitiesMap.get(strId) || working[i];
                                    const updated = protectEnrichedFieldsOnMerge(
                                        stripUndefinedFields({ ...working[i], ...update.data }),
                                        existingBase,
                                        mergeProtectOpts,
                                    );
                                    working[i] = updated;
                                    workingMap.set(strId, updated);
                                }
                            }
                            onImport(enrichResult.updates.map(({ id, data }) => {
                                const prev = workingMap.get(String(id)) || {};
                                return protectEnrichedFieldsOnMerge({ ...prev, ...data }, prev, mergeProtectOpts);
                            }));
                        }
                    }
                } catch (e) {
                    console.warn('[Sync] Strava enrich failed:', e);
                    stravaEnrichWarning = e?.message || 'Strava enrichment failed during sync.';
                }
            }

            working = await applyIntervalsMapEnrichmentToList(
                working,
                activitiesMap,
                (m) => setSyncErrorDetail(String(m)),
            );

            onImport(working);

            const refreshSingleDay = syncStart === syncEnd;
            const driftResult = await applyPostSyncDriftEnrich(working, activitiesMap, enrichOptions, {
                maxFetches: refreshSingleDay
                    ? (enrichOptions.driftMaxFetchesToday ?? syncEnrichLimits.driftMaxFetchesToday)
                    : (enrichOptions.driftMaxFetches ?? syncEnrichLimits.driftMaxFetches),
            });
            working = driftResult.list;

            const skippedEmpty = Number(syncStats?.skippedEmpty) || 0;
            recordIntervalsSyncSuccess({
                added: orphanMerged.length,
                updated: mergedNews.length,
                skipped: skippedEmpty,
                importHealth: syncStats?.health,
                syncRoute: syncStats?.syncRoute,
                syncDepth: syncDepth,
            });
            onImportFinished?.(buildPostImportActivityList(activities, [...working, ...orphanMerged]));

            setSyncStatus('done');
            const parts = [];
            if (mergedNews.length > 0) parts.push(`${mergedNews.length} Intervals row(s) saved`);
            if (newActivitiesRaw.length > mergedNews.length) {
                parts.push(`${newActivitiesRaw.length - mergedNews.length} fetched id(s) not in selection`);
            }
            parts.push(...formatStravaGapFillSummaryParts(gapResult.stats));
            if (skippedEmpty > 0) {
                parts.push(`${skippedEmpty} skipped (no distance/time/power)`);
            }
            parts.push(...formatIntervalsImportHealthParts(syncStats?.health));
            if (syncStats?.syncRoute === 'direct') parts.push('route: direct API');
            else if (syncStats?.syncRoute === 'cloud') parts.push('route: cloud sync');
            if (enrichedLinkCount > 0) parts.push(`${enrichedLinkCount} Strava link update(s)`);
            if (segmentRefreshCount > 0) parts.push(`${segmentRefreshCount} Strava detail + segment refresh`);
            if (detailFailed > 0) parts.push(`${detailFailed} detail error(s)`);
            if (stravaEnrichWarning) parts.push(`Strava enrich warning: ${stravaEnrichWarning}`);
            if (driftResult.driftEnrichedCount > 0) {
                parts.push(`${driftResult.driftEnrichedCount} HR drift analysis update(s)`);
            }
            const driftRemainder = formatSyncDriftRemainderNote(driftResult.driftRemainingCount);
            if (driftRemainder) parts.push(driftRemainder);
            setSyncErrorDetail(
                parts.length > 0
                    ? `✅ Sync complete. ${parts.join(' · ')}.`
                    : '✅ Sync complete. No Intervals changes for selected ids; Strava refresh attempted.',
            );
            showToast(
                parts.length > 0
                    ? `Sync complete. ${parts.join(' · ')}.`
                    : 'Sync complete. No Intervals changes for selected rows.',
                { variant: 'success' },
            );
            setTimeout(() => setSyncStatus(null), 9000);
        } catch (e) {
            console.error('Sync failed:', e);
            setSyncStatus('error');
            setSyncErrorDetail(`❌ Error: ${e.message}`);
            showToast(e.message || 'Sync failed.', { variant: 'error', durationMs: 10000 });
        }
    }, [
        bulkSelectedIds,
        selectedActivitiesForBulk,
        activities,
        syncIntervals,
        stravaGetToken,
        onImport,
        deviceProfileTitles,
        getSelectedSportTypes,
        showToast,
        stravaEnrichEnabled,
        recordIntervalsSyncSuccess,
        buildSyncEnrichOptions,
        applyPostSyncDriftEnrich,
        getActivitiesSnapshot,
        onImportFinished,
        applyStravaGapFillToBatch,
        persistImportedActivities,
        syncDepth,
    ]);

    const fetchAndMergeIntervalsRange = useCallback(async (syncStart, syncEnd) => {
        if (!syncStart || !syncEnd) {
            setSyncStatus('error');
            setSyncErrorDetail('Choose a valid From and To date for fetching new activities.');
            setTimeout(() => setSyncStatus(null), 7000);
            return;
        }
        if (syncStart > syncEnd) {
            setSyncStatus('error');
            setSyncErrorDetail('From date must be on or before To date.');
            setTimeout(() => setSyncStatus(null), 7000);
            return;
        }

        setIsFetchingNewIntervals(true);
        setSyncStatus('started');
        setSyncErrorDetail(`Fetching Intervals.icu ${syncStart} → ${syncEnd}…`);

        try {
            const selectedTypes = getSelectedSportTypes();
            if (selectedTypes.length === 0) {
                setSyncStatus('error');
                setSyncErrorDetail('Select at least one sport type to sync.');
                showToast('Select at least one sport type to sync.', { variant: 'warning' });
                setTimeout(() => setSyncStatus(null), 7000);
                return;
            }
            const enrichOptions = await buildSyncEnrichOptions();
            const syncResult = await syncIntervals(syncStart, syncEnd, selectedTypes, enrichOptions);
            const newActivitiesRaw = syncResult.activities || [];
            const syncStats = syncResult.stats;
            const mergeCounts = countMergeCategories(newActivitiesRaw, activities);

            const activitiesMap = buildActivitiesLookupMap(activities, getActivitiesSnapshot);

            const mergeNewInto = (act) => {
                const existing = activitiesMap.get(String(act.id));
                return existing ? protectEnrichedFieldsOnMerge(act, existing, mergeProtectOpts) : act;
            };

            setSyncErrorDetail(`Strava link + gap fill for ${syncStart} → ${syncEnd}…`);
            const gapResult = await applyStravaGapFillToBatch({
                intervalsBatch: newActivitiesRaw || [],
                syncStart,
                syncEnd,
                selectedTypes,
                activitiesMap,
                onProgress: (m) => setSyncErrorDetail(String(m)),
            });

            let merged = (gapResult.intervalsActivities || []).map(mergeNewInto);
            const orphanMerged = (gapResult.orphanActivities || []).map(mergeNewInto);
            const allImported = [...merged, ...orphanMerged];
            const stravaListForSummary = gapResult.stravaList ?? null;

            await persistImportedActivities(allImported, activitiesMap);
            if (allImported.length > 0) {
                onImport(allImported);
            }

            if (!isFullSyncDepth(syncDepth)) {
                const orphanMergeCounts = countMergeCategories(orphanMerged, activities);
                recordIntervalsSyncSuccess({
                    added: mergeCounts.newCount + orphanMergeCounts.newCount,
                    updated: mergeCounts.updatedCount + orphanMergeCounts.updatedCount,
                    skipped: Number(syncStats?.skippedEmpty) || 0,
                    importHealth: syncStats?.health,
                    syncRoute: syncStats?.syncRoute,
                    syncDepth: syncDepth,
                });
                onImportFinished?.(buildPostImportActivityList(activities, allImported));

                setSyncStatus('done');
                const summary = formatIntervalsSyncSummary(syncStats, mergeCounts);
                const parts = [summary, 'Fast sync (Intervals only — no Strava/drift)'];
                setSyncErrorDetail(`✅ ${parts.join(' · ')}.`);
                showToast(parts.join(' · '), { variant: 'success' });
                setTimeout(() => setSyncStatus(null), 9000);
                return;
            }

            let enrichCount = 0;
            let segmentRefreshCount = 0;
            let detailFailed = 0;
            let stravaEnrichWarning = null;
            if (stravaEnrichEnabled && stravaGetToken && allImported.length > 0) {
                setSyncStatus('enriching');
                setSyncErrorDetail('Strava: auto-link + gear/HR/RPE/KOM for fetched rides…');
                try {
                    const token = await stravaGetToken();
                    if (token) {
                        const enrichResult = await enrichSelectedActivitiesFromStrava(allImported, token, {
                            forceStravaDetail: true,
                            concurrency: 3,
                            deviceProfileTitles,
                            dataSourcePrefs: mergeProtectOpts.dataSourcePrefs,
                            onProgress: (m) => setSyncErrorDetail(String(m)),
                        });
                        enrichCount = enrichResult.updates.length;
                        segmentRefreshCount = enrichResult.detailUpdatedCount;
                        detailFailed = enrichResult.failed;
                        if (enrichResult.updates.length > 0) {
                            const mergedMap = new Map((merged || []).map((a) => [String(a.id), a]));
                            if (db) {
                                await persistActivityUpdates(
                                    enrichResult.updates,
                                    new Map([...mergedMap, ...activitiesMap]),
                                    mergeProtectOpts,
                                    resolveOwnerUid(),
                                );
                            }
                            const updatesMap = new Map(enrichResult.updates.map((u) => [String(u.id), u]));
                            for (let i = 0; i < merged.length; i++) {
                                const strId = String(merged[i].id);
                                const update = updatesMap.get(strId);
                                if (update) {
                                    const existingBase = activitiesMap.get(strId) || merged[i];
                                    const updatedData = protectEnrichedFieldsOnMerge(
                                        stripUndefinedFields({ ...merged[i], ...update.data }),
                                        existingBase,
                                        mergeProtectOpts,
                                    );
                                    merged[i] = updatedData;
                                    mergedMap.set(strId, updatedData);
                                }
                            }
                            onImport(enrichResult.updates.map(({ id, data }) => {
                                const prev = mergedMap.get(String(id)) || {};
                                return protectEnrichedFieldsOnMerge({ ...prev, ...data }, prev, mergeProtectOpts);
                            }));
                        }
                    }
                } catch (e) {
                    console.warn('[Fetch new] Strava enrich failed:', e);
                    stravaEnrichWarning = e?.message || 'Strava enrichment failed during fetch.';
                }
            }

            const mapEnriched = await applyIntervalsMapEnrichmentToList(
                allImported,
                activitiesMap,
                (m) => setSyncErrorDetail(String(m)),
            );
            for (let i = 0; i < merged.length; i++) {
                const id = String(merged[i].id);
                const row = mapEnriched.find((a) => String(a.id) === id);
                if (row) merged[i] = row;
            }
            onImport(mapEnriched);

            const isSingleDaySync = syncStart === syncEnd;
            const driftResult = await applyPostSyncDriftEnrich(
                allImported,
                activitiesMap,
                enrichOptions,
                {
                    maxFetches: isSingleDaySync
                        ? (enrichOptions.driftMaxFetchesToday ?? syncEnrichLimits.driftMaxFetchesToday)
                        : (enrichOptions.driftMaxFetches ?? syncEnrichLimits.driftMaxFetches),
                },
            );
            merged = driftResult.list;

            const orphanMergeCounts = countMergeCategories(orphanMerged, activities);
            recordIntervalsSyncSuccess({
                added: mergeCounts.newCount + orphanMergeCounts.newCount,
                updated: mergeCounts.updatedCount + orphanMergeCounts.updatedCount,
                skipped: Number(syncStats?.skippedEmpty) || 0,
                importHealth: syncStats?.health,
                syncRoute: syncStats?.syncRoute,
                syncDepth: syncDepth,
            });
            onImportFinished?.(buildPostImportActivityList(activities, merged));

            setSyncStatus('done');
            const summary = formatIntervalsSyncSummary(syncStats, mergeCounts);
            const parts = [summary];
            parts.push(...formatStravaGapFillSummaryParts(gapResult.stats));
            let stravaUnmatchedCount = 0;
            if (stravaListForSummary) {
                const stravaMatchSummary = buildStravaSyncMatchSummary({
                    siteActivities: merged,
                    stravaList: stravaListForSummary,
                    startYmd: syncStart,
                    endYmd: syncEnd,
                    intervalsImported: Number(syncStats?.imported) || (gapResult.intervalsActivities || []).length,
                });
                stravaUnmatchedCount = stravaMatchSummary.unmatchedCount;
                const stravaSummaryText = formatStravaSyncMatchSummary(stravaMatchSummary);
                if (stravaSummaryText) parts.push(stravaSummaryText);
            }
            if (stravaEnrichEnabled && stravaGetToken && allImported.length > 0) {
                if (!stravaListForSummary) parts.push('Strava link + enrich');
                if (enrichCount > 0) parts.push(`${enrichCount} field update(s) from Strava`);
                if (segmentRefreshCount > 0) parts.push(`${segmentRefreshCount} detail/KOM refresh`);
                if (detailFailed > 0) parts.push(`${detailFailed} detail error(s)`);
                if (stravaEnrichWarning) parts.push(`Strava enrich warning: ${stravaEnrichWarning}`);
            } else if (allImported.length > 0 && !stravaEnrichEnabled) {
                parts.push('Strava enrich skipped');
            } else if (allImported.length > 0) {
                parts.push('connect Strava in Settings for auto-link + details');
            }
            if (driftResult.driftEnrichedCount > 0) {
                parts.push(`${driftResult.driftEnrichedCount} HR drift analysis update(s)`);
            }
            const driftRemainder = formatSyncDriftRemainderNote(driftResult.driftRemainingCount);
            if (driftRemainder) parts.push(driftRemainder);
            const detailText = allImported.length > 0
                ? `✅ ${parts.join(' · ')}.`
                : summary;
            setSyncErrorDetail(detailText);
            const toastVariant = allImported.length > 0
                ? ((Number(syncStats?.skippedEmpty) || 0) > 0 || stravaUnmatchedCount > 0 ? 'warning' : 'success')
                : 'info';
            showToast(
                allImported.length > 0 ? parts.join(' · ') : summary,
                { variant: toastVariant },
            );
            setTimeout(() => setSyncStatus(null), 9000);
        } catch (e) {
            console.error('Fetch new from Intervals failed:', e);
            setSyncStatus('error');
            setSyncErrorDetail(`❌ ${e.message || e}`);
            showToast(e.message || 'Intervals fetch failed.', { variant: 'error', durationMs: 10000 });
            setTimeout(() => setSyncStatus(null), 10000);
        } finally {
            setIsFetchingNewIntervals(false);
        }
    }, [
        syncIntervals,
        activities,
        stravaGetToken,
        onImport,
        deviceProfileTitles,
        getSelectedSportTypes,
        showToast,
        stravaEnrichEnabled,
        recordIntervalsSyncSuccess,
        buildSyncEnrichOptions,
        applyPostSyncDriftEnrich,
        getActivitiesSnapshot,
        onImportFinished,
        applyStravaGapFillToBatch,
        persistImportedActivities,
        syncDepth,
    ]);

    const handleFetchNewFromIntervals = useCallback(async () => {
        return fetchAndMergeIntervalsRange(syncDates.start, syncDates.end);
    }, [fetchAndMergeIntervalsRange, syncDates.start, syncDates.end]);

    const handleRunSync = useCallback((overrideBulkIds, overrideSelectedActs) => {
        if (syncMode === 'refresh-selected') {
            return handleSync(overrideBulkIds, overrideSelectedActs);
        }
        return handleFetchNewFromIntervals();
    }, [syncMode, handleSync, handleFetchNewFromIntervals]);

    return {
        syncStatus,
        syncErrorDetail,
        syncDates,
        setSyncDates,
        fetchIntervalsDates: syncDates,
        setFetchIntervalsDates: setSyncDates,
        syncMode,
        setSyncMode,
        sportFilters,
        toggleSportFilter,
        setAllSportFilters,
        stravaEnrichEnabled,
        setStravaEnrichEnabled,
        syncDepth,
        setSyncDepth,
        handleRunSync,
        isFetchingNewIntervals,
        handleSync,
        handleFetchNewFromIntervals,
        fetchAndMergeIntervalsRange,
        isSyncing,
        syncProgress,
        lastIntervalsSyncAt,
        lastSyncHealthSummary,
    };
}

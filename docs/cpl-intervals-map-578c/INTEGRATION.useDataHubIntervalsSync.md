# `useDataHubIntervalsSync.js` — intervals_map hook

Voeg toe **binnen** `useDataHubIntervalsSync`, na `mergeProtectOpts` / `showToast`:

```javascript
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
```

**Aanroep 1** — selected-row sync, na Strava-enrich blok, vóór `onImport(working)`:

```javascript
            working = await applyIntervalsMapEnrichmentToList(
                working,
                activitiesMap,
                (m) => setSyncErrorDetail(String(m)),
            );
```

**Aanroep 2** — fetch-range sync, na Strava-enrich, vóór drift-enrich:

```javascript
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
```

Zie `useDataHubIntervalsSync.intervals_map.reference.js` voor volledig bestand ter controle.

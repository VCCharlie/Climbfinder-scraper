# Portable modules voor Climb Performance Lab

Deze bestanden zijn **bron van waarheid** in de FietsKlim-repo; kopieer ze naar CPL (zelfde pad onder `functions/` of `shared/fietsklim/`).

| Bestand | Rol |
|---------|-----|
| `../../../functions/fietsklimMatchSchema.js` | `fietsklim_match` op `activities/{id}` |
| `../../../functions/fietsklimUserLinksSchema.js` | `fietsklim_user_links` op activiteit |
| `../../../functions/fietsklimJournalSchema.js` | Journal-entry + merge-logica |
| `../../../functions/cplClimbJournal.js` | Firestore-paden + aggregatie (pas `getCplFirestore` aan naar lokale admin SDK) |

## Firestore-paden (CPL)

```
activities/{activityId}
  fietsklim_match: { … }
  fietsklim_user_links: [ { datasetId, climbId, … } ]

users/{cplOwnerId}/fietsklim_journal/{datasetId__climbId}
  ascent_count, first_claimed_at, last_ascent_at, ascents[]
```

## CPL-app flow

1. Rit-UI: zoek klim → push op `fietsklim_user_links` (of roep FietsKlim callable `cplLinkClimbOnActivity` aan).
2. Matcher (lokaal of worker): schrijf `fietsklim_match`.
3. Na match of link: `applyActivitiesToCplJournal(ownerId, rows)` — zie `cplClimbJournal.js`.
4. FietsKlim importeert journal → `climbLog` (server-sync of import-only).

## Security rules (schets)

```javascript
match /users/{userId}/fietsklim_journal/{entryId} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
}
match /activities/{activityId} {
  allow update: if request.auth.uid == resource.data.ownerId
    && request.resource.data.diff(resource.data).affectedKeys()
      .hasOnly(['fietsklim_user_links', 'fietsklim_match', ...]);
}
```

# CPL Firestore-index (climb-performance-lab)

FietsKlim CPL-sync met **ritdatum van/tot** gebruikt:

`activities` where `ownerId` == … and `date` >= … and `date` <= … orderBy `date` desc

Zonder composite index faalt de query; sync geeft dan **0 ritten** (`dateQueryIndexRequired` in `lastSyncSummary`).

## Index aanmaken

Firebase Console → project **climb-performance-lab** → Firestore → **Indexes** → composite index:

| Collection | Fields |
|------------|--------|
| `activities` | `ownerId` Asc, `date` Desc |

Of via `firestore.indexes.json` in Climb-Performance-Lab en deploy indexes.

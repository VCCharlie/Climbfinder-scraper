# CPL Firestore-index (climb-performance-lab)

FietsKlim CPL-sync met **ritdatum van/tot** gebruikt:

`activities` where `ownerId` == … and `date` >= … and `date` <= … orderBy `date` desc

Zonder composite index faalt de query; sync geeft dan **0 ritten** (`dateQueryIndexRequired` in `lastSyncSummary`).

## Index aanmaken (eenmalig)

Project: **climb-performance-lab** (CPL), niet climb-database.

### Optie A — Firebase Console

1. [Firestore → Indexes](https://console.firebase.google.com/project/climb-performance-lab/firestore/indexes)
2. **Create index** → Composite  
3. Collection: **`activities`**  
4. Velden: **`ownerId`** Ascending, **`date`** Descending  
5. **Create** — bouwen duurt enkele minuten (status *Building* → *Enabled*).

### Optie B — CLI (CPL-repo root)

Kopieer `firestore.indexes.json` uit deze map naar de CPL-repo (of merge met bestaande), dan:

```bash
firebase deploy --only firestore:indexes --project climb-performance-lab
```

### Daarna

1. Lopende zinloze CPL-job op FietsKlim: **Annuleer server-job**.  
2. Instellingen → zelfde datumbereik → **Logboek · CPL · periode (server)** opnieuw.  
3. In het CPL-run paneel: **Ritten met route** moet > 0 zijn als CPL die dagen maps heeft.

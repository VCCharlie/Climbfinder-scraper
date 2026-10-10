# GPS / locatie in FietsKlim (PWA op GitHub Pages)

FietsKlim vraagt **alleen** om je locatie als je op de **locatie-knop** op de kaart tikt (blauw kruis rechtsonder). Er is geen automatische GPS-start meer bij het openen van de app.

## Symptoom: Google Maps werkt, FietsKlim (of een andere PWA) niet

Dat wijst meestal **niet** op kapotte GPS-hardware, maar op **machtigingen per app** of **PWA-context**:

- **Site-locatie “Toegestaan”** in de browser is niet genoeg als **Brave/Chrome zelf** geen locatie mag gebruiken.
- Een **PWA op het startscherm** kan andere rechten hebben dan dezelfde site in een gewoon tabblad.

## Stappen op Android (Brave)

1. Zet **Locatie/GPS** aan in Android-instellingen (hoog niveau).
2. **Site:** slot-icoon naast `vccharlie.github.io` → Site-instellingen → **Locatie → Toestaan**.
3. **Brave-app:** Instellingen → **Apps** → **Brave** → **Machtigingen** → **Locatie → Toestaan** (niet “Alleen tijdens gebruik” weigeren als GPS nooit komt).
4. **Shields:** voor FietsKlim Shields uit of locatie voor de site toestaan.
5. Open FietsKlim via het **icoon op je startscherm** (PWA), tik opnieuw op **Mijn locatie** en wacht tot ~1 minuut (eerst netwerk/lage nauwkeurigheid, daarna GPS).
6. Werkt het in Brave-tab wel maar niet als PWA: PWA verwijderen van startscherm, cache legen, opnieuw **Toevoegen aan startscherm**, opnieuw locatie-knop tikken.

## Stappen op Android (Chrome)

Zelfde idee: **Instellingen → Apps → Chrome → Machtigingen → Locatie**.

## Foutmelding in FietsKlim

De oranje regel onder de zoekbalk vervangt pop-ups. Na een mislukte poging zie je soms een **eenmalige** extra tip voor Brave/Android.

## Technische notities

- De service worker cached alleen statische bestanden; die blokkeert geen GPS.
- Zonder gebruikersgebaar weigeren sommige browsers (vooral Android PWA) stilletjes locatie — daarom alleen locatie na knop-tik.

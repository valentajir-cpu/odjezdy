# Odjezdy MHD

Mobilni stranka s prehledem primych spoju IDS JMK ze zastavky A do zastavky B:
za jak dlouho co jede, s zivym zpozdenim a s ohledem na cas dojiti na zastavku.

## Jak to funguje

- `docs/index.html`, `docs/app.js` - samotna stranka (GitHub Pages ze slozky `/docs`).
- `docs/data.json` - zhusteny jizdni rad, generuje ho `scripts/build_data.py`.
- `.github/workflows/update-data.yml` - jednou denne stahne GTFS a data prepocita.
- Ziva data: stranka cte proud vozidel KORDIS (`gis.brno.cz`) primo v prohlizeci
  a zpozdeni vozu pricita k casu podle radu. Prirazeni vozu ke spoji je odhad.

## Rucni prepocet dat

    python scripts/build_data.py              # stahne GTFS z kordis-jmk.cz
    python scripts/build_data.py gtfs.zip     # pouzije lokalni soubor

## Data

Jizdni rad a polohy vozidel: KORDIS JMK, a.s. a statutarni mesto Brno (data.brno.cz), licence CC BY 4.0.

# @aerial/geo

- `@aerial/geo` — place dictionary (`PLACES`, `DICTIONARY_VERSION`) and lookups `byId`, `children`, `ancestors`, `byNeptunKey`. Server and worker only by convention.
- `@aerial/geo/geometry` — `AREA_GEOMETRY`, a static GeoJSON FeatureCollection. This is the only geo entry point the web app may import.
- `@aerial/geo/match` — alias and case-form matching (owned by the matching unit).

## Dictionary v1

It covers Полтавська область, its 4 raions (2020 reform), all 16 cities of the oblast, villages named in the source channels, and the 7 neighbouring oblasts (these are context only). Aliases hold base nominative forms only. Case forms belong to `match`.

`neptunKeys` are the exact `key` values from NEPTUN `GET /api/v1/alerts` (`raions[].key` / `oblasts[].key`) and from its `raions.geojson` / `oblasts.geojson`, checked on 2026-09-21. Examples: `полтавська`, `полтавський`, `кременчуцький`, `миргородський`, `лубенський`. Cities have no NEPTUN key. Walk `ancestors()` to reach their raion or oblast.

Any change to `PLACES` must bump `DICTIONARY_VERSION`. Never reuse or rename a place ID.

## Geometry source and licence

`src/geometry.json` comes from NEPTUN's public boundary files https://neptun.in.ua/raions.geojson and https://neptun.in.ua/oblasts.geojson (fetched 2026-09-21). It keeps only the `полтавська` oblast and its 4 raions, rounds coordinates to 4 decimals (about 11 m), and drops consecutive duplicate points. `properties.key` was replaced with our place `id`, `name` and `level`. The file is about 30 KB.

Licence status, which is **not fully resolved**:

- The NEPTUN API terms (https://neptun.in.ua/api-terms, updated 2026-07-09) allow free commercial and non-commercial use. The condition is a visible link to NEPTUN next to the map or data: `Дані: Карта повітряних тривог — NEPTUN` → https://neptun.in.ua/.
- The same terms (section 7) say map data belongs to its rights holders ("OpenStreetMap, Esri та ін.") and is used under their licences. The boundaries are most likely OSM-derived, so they fall under the ODbL.

Until this is confirmed, any map that renders this geometry must show both attributions: "Дані: Карта повітряних тривог — NEPTUN" (linked) and "© OpenStreetMap contributors (ODbL)". If ODbL share-alike is a problem, replace the file with geoBoundaries (CC BY 4.0) polygons. Keep the same `properties.id` values.

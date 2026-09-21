# @aerial/geo

- `@aerial/geo` — place dictionary (`PLACES`, `DICTIONARY_VERSION`) and lookups `byId`, `children`, `ancestors`, `byNeptunKey`. Server and worker only by convention.
- `@aerial/geo/geometry` — `AREA_GEOMETRY`, a static GeoJSON FeatureCollection. This is the only geo entry point the web app may import.
- `@aerial/geo/match` — `extractPlaceCandidates(text)`: place mentions with case forms, evidence spans and the literal relation (`in`, `towards`, `over`, `near`, `past`, `region_of`, `unknown`). Server and worker only.

## Dictionary v2

v2 adds the villages Устимівка and Кам'яні Потоки to Кременчуцький район, plus two lists that `match` reads:

- `SUB_AREAS`: city districts. They are not places of their own. A match resolves to the city and keeps the district name as `subArea`: Половки, Рибці and Авіамістечко for Полтава; Крюків, Крюківський район and Автозаводський район for Кременчук.
- `AMBIGUOUS_NAMES`: names that several villages of the oblast share, such as Петрівка and Михайлівка. A match always comes back with `ambiguous: true` and `placeId: null`. It is never resolved.

## Dictionary v1

It covers Полтавська область, its 4 raions (2020 reform), all 16 cities of the oblast, villages named in the source channels, and the 7 neighbouring oblasts (these are context only). Aliases hold base nominative forms only. Case forms belong to `match`.

`neptunKeys` are the exact `key` values from NEPTUN `GET /api/v1/alerts` (`raions[].key` / `oblasts[].key`) and from its `raions.geojson` / `oblasts.geojson`, checked on 2026-09-21. Examples: `полтавська`, `полтавський`, `кременчуцький`, `миргородський`, `лубенський`. Cities have no NEPTUN key. Walk `ancestors()` to reach their raion or oblast.

Any change to `PLACES`, `SUB_AREAS` or `AMBIGUOUS_NAMES` must bump `DICTIONARY_VERSION`. Never reuse or rename a place ID.

## Geometry source and licence

`src/geometry.json` comes from NEPTUN's public boundary files https://neptun.in.ua/raions.geojson and https://neptun.in.ua/oblasts.geojson (fetched 2026-09-21). It keeps only the `полтавська` oblast and its 4 raions, rounds coordinates to 4 decimals (about 11 m), and drops consecutive duplicate points. `properties.key` was replaced with our place `id`, `name` and `level`. The file is about 30 KB.

Licence status, which is **not fully resolved**:

- The NEPTUN API terms (https://neptun.in.ua/api-terms, updated 2026-07-09) allow free commercial and non-commercial use. The condition is a visible link to NEPTUN next to the map or data: `Дані: Карта повітряних тривог — NEPTUN` → https://neptun.in.ua/.
- The same terms (section 7) say map data belongs to its rights holders ("OpenStreetMap, Esri та ін.") and is used under their licences. The boundaries are most likely OSM-derived, so they fall under the ODbL.

Until this is confirmed, any map that renders this geometry must show both attributions: "Дані: Карта повітряних тривог — NEPTUN" (linked) and "© OpenStreetMap contributors (ODbL)". If ODbL share-alike is a problem, replace the file with geoBoundaries (CC BY 4.0) polygons. Keep the same `properties.id` values.

## Matching rules (`@aerial/geo/match`)

- Case forms are generated from the nominative aliases: noun and adjective declension, -ів → -ов (Крюків → Крюкові), к → ц (Кременчук → Кременчуці), fleeting vowels (Лубни → Лубен), and the abbreviations `р-н` and `обл.`. Matching compares whole tokens, and the longest phrase wins.
- Comparison is case-insensitive. It folds every apostrophe variant (`'`, `’`, `ʼ`, `` ` ``) and Latin look-alike letters (`Полтавi` with a Latin `i`). Settlement names (city, village, district) must still start with a capital letter because some of them are also common words (гребінка, заводському, мачухи, рибці). Oblast and raion names match in any case.
- Levels stay separate. «на Полтавщині» is the oblast, «у Полтавському районі» is the raion, and «Полтава» is the city. Adjectives only match together with `район`/`область`, so «Полтавська ТЕЦ» and «Кременчуцьке водосховище» match nothing.
- The relation comes from the words between the previous match and the name, within the same clause. «у напрямку Кременчука» is `towards`, not `in`. `на`/`у` read the case: locative means `in`, accusative means `towards`. «на/повз Полтаву» is `unknown`. Items of a list in a shared case (`Мачухи/Судіївку`) take the relation of the first item.
- Names that are not in the dictionary give no candidate. That covers «біля аеропорту», «над містом» and towns outside the oblast. Coordinates are never returned.
- Spans are offsets into the exact input string. Callers pass the revision's `normalizedText`. A channel signature such as «ППО - Energy Полтава» also produces a Полтава candidate, so the pipeline has to ignore candidates inside the signature/footer that `cleanedText` removes.

## REVIEW_CANDIDATES

These names appear in the source exports but are not in the dictionary, because they could not be placed with confidence. Confirm each one before adding it.

| Name in the exports | Why it is left out |
| --- | --- |
| Підгорівка («на трасі Кременчук–Полтава») | The raion is not confirmed. |
| Пушкарівський / Пушкарівка (Полтава, «м-н … (Половки)») | Probably a Полтава micro-district. The exact name form is unclear. |
| Реївка, Занасип, Молодіжний (Кременчук) | Probably Кременчук micro-districts. «Молодіжний» is also a common adjective. |
| Петрівка (Кременчук traffic news) | Possibly a Кременчук micro-district. It is listed in `AMBIGUOUS_NAMES`, so it stays unresolved. |
| Браїлки | The export calls it a Полтава micro-district (`м-н`), but v1 lists it as village `ua-pl-v-brailky`. Check it before any change. The ID stays reserved. |
| Полтавська громада, Глобинська громада | These are hromada level, and the dictionary has no hromadas yet. |
| Черкаси, Сміла, Прилуки, Власівка | These towns are in neighbouring oblasts. Adding them needs raions of those oblasts. |

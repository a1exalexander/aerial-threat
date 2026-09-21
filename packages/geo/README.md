# @aerial/geo

- `@aerial/geo` — place dictionary (`PLACES`, `DICTIONARY_VERSION`) and lookups `byId`, `children`, `ancestors`, `byNeptunKey`, `isInKremenchukRaion`. Server and worker only by convention.
- `@aerial/geo/geometry` — `AREA_GEOMETRY`, a static GeoJSON FeatureCollection. This is the only geo entry point the web app may import.
- `@aerial/geo/match` — `extractPlaceCandidates(text)`: place mentions with case forms, evidence spans and the literal relation (`in`, `towards`, `over`, `near`, `past`, `region_of`, `unknown`). `extractRoute(text)`: the ordered stops of a route list. Server and worker only.

## Dictionary v3

v3 adds the stops of the drone routes the Kremenchuk channels report, plus Russian and surzhyk spellings:

- Кременчуцький район: Козельщина, Манжелія, Ламане, Погреби, Градизьк, Омельник, Семенівка. Полтавський район: Опішня, Диканька, Машівка, Чутове. `village` covers every settlement below city status, so селища (former смт) are `village` too.
- Neighbour oblasts get the raions their stops need (no NEPTUN keys; context only): Дніпровський (Дніпро, Царичанка), Кропивницький (Кропивницький, Канатове), Олександрійський (Олександрія, Світловодськ, Онуфріївка, Павлиш), Черкаський (Черкаси, Чигирин).
- Russian aliases sit next to the Ukrainian ones: Кременчуг, Горишние/Горишни Плавни, Глобино, Козелищина, Манжелия/Манежелия, Ламаное, Градижск/Градисжк, Семеновка, Опошня, Днепр, Черкассы, Кроп/Кроп-р/Кропивницкий, Онуфриевка, Каменные Потоки, and the Russian oblast and raion names (Черкасская область, Кременчугский район).
- `isInKremenchukRaion(id)` is true for the raion and every place under it. It decides "passing near Kremenchuk".

Recall over the Кременчуцький Миколай export (365 posts with text): 240 of 245 posts that name a tracked place resolve it (98.0%). The misses are one-off typos and «по руслу Днепра» (the river, on purpose). Over Х Кременчук (156 posts): 20 of 20.

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
- Russian and surzhyk: keys fold ы → и, э → е and ё → е (Погребы = Погреби, Павлыш = Павлиш), and the case generator adds Russian endings next to the Ukrainian ones (Полтаве, Кременчуге, Градижском, Черкасской обл, Горишних Плавней). Russian prepositions count too: `к`, `в направлении` (towards), `возле`, `около`, `рядом с` (near), `мимо` (past), `в районе` (region_of).
- «над Дніпром», «по (руслу) Дніпру», «через Дніпро», «вздовж Дніпра» may be the river. Дніпро there comes back ambiguous: `placeId: null`, `alternatives: ['ua-dp-c-dnipro']`.
- Spans are offsets into the exact input string. Callers pass the revision's `normalizedText`. A channel signature such as «ППО - Energy Полтава» also produces a Полтава candidate, so the pipeline has to ignore candidates inside the signature/footer that `cleanedText` removes.

## Routes (`extractRoute`)

- A route is the longest run of ≥2 settlement names on one line joined by «/», «→», «->», «,», a spaced dash, or «, далі (на) …». At least one name must be in the dictionary, so «Шахед/Гербера» or «Київ/Бориспіль» is no route. A comma-only run needs 3 names, so prose such as «у Полтаві, Кременчуці» is no route. Oblast and raion mentions are not stops and break a run. A line break ends it.
- Each stop is `{name, placeId}`. `name` is the dictionary's Ukrainian nominative (a city district keeps its own name, such as Крюків). Names outside the dictionary keep their surface form with `placeId: null`, such as «Кияшки» or «Нова Галещина».
- «(і/и) (далі) на воду» right after the run adds the terminus `{name: 'на воду', placeId: null}`: over the Dnipro or the Kremenchuk reservoir. It is never a place.
- The function returns null when the text has no route.

Over the Миколай export, 61 posts have a route. They hold 181 stops (not counting «на воду»), and 153 of them resolve (84.5%). The unresolved stops are listed below.

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
| Сміла, Прилуки, Власівка | These towns are in neighbouring oblasts. Adding them needs raions of those oblasts. Черкаси was added in v3. |
| Успенка (7 route stops, next to Онуфріївка) | Many villages share this name. It is probably the one in Олександрійський район, but that is not confirmed. |
| Садки, Раківка («Раковка»), Чечелеве («Чечелево»), «274 квартал» | These are probably Кременчук micro-districts, so they would go into `SUB_AREAS`. Confirm the names first. |
| Крюков (Russian for Крюків) | `SUB_AREAS` keeps display names only. A Russian alias for a district needs a separate alias list. |
| Щербаки, Келеберда, Кияшки, Нова Галещина, Мала Кахнівка, Бутенки, Рокитне, Федоренки, Піщане, Дереївка, Пришиб, Салівка, Нова Знам'янка, Солошине, Дмитрівка | Villages around Кременчук and Козельщина. The raion is probably Кременчуцький, but it is not verified. Келеберда also exists in Черкаська область. Рокитне, Піщане and Дмитрівка are common names. |
| Знам'янка | It is in Кіровоградська область. «Новой Знаменке» (Нова Знам'янка, Кременчуцький район) would resolve to it, so Нова Знам'янка has to be added first. |
| Кам'янське, Перещепине, Світлогірське, Млинок, Подорожнє, П'ятихатки, Аджамка, Велика Скелева, Григорівка, Самар, Златопіль, Балаклія | Places in neighbouring oblasts. Each needs its raion. |
| Матвіївка (next to Чигирин) | Many villages share this name, and the raion is not confirmed. |
| Полтавка | This is probably a typo for Полтава. |
| Гражижск, Царицанка, Горишный Плавни, Коезльщина, Греби, Каменые Потоки, Потоки | Rare typos and clipped forms (1–3 posts each). They are not aliased. |

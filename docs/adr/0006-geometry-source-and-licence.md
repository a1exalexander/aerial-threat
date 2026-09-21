# 0006. Map geometry source and licence

Status: accepted; the licence question is still open

## Context

The overview map shows the Poltava oblast and its 4 raions. The keys must match NEPTUN alert keys, and doc 06 requires the origin and licence of the geometry to be documented before it enters the repo.

## Decision

- `packages/geo/src/geometry.json` is derived from NEPTUN's public `raions.geojson` and `oblasts.geojson` (fetched 2026-09-21). It is simplified to 4 decimals and re-keyed to our stable place IDs. Details are in `packages/geo/README.md`.
- The NEPTUN API terms allow use with a visible link: "Дані: Карта повітряних тривог — NEPTUN" → https://neptun.in.ua/. The terms also say map data belongs to its rights holders (OpenStreetMap, Esri and others). The boundaries are therefore most likely **OSM-derived, which means ODbL**.
- Until that is confirmed, every map shows both attributions: the NEPTUN link and "© OpenStreetMap contributors (ODbL)".
- Fallback: if ODbL share-alike obligations are unacceptable, replace the file with **geoBoundaries** (CC BY 4.0) polygons that keep the same `properties.id`, and credit geoBoundaries.

## Consequences

- The web app imports geometry only through `@aerial/geo/geometry`. Swapping the source changes one file, not the UI.
- The base map tiles are a separate licence and cost question, covered in 0007.

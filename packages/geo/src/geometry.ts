// Browser-safe: static polygons only. Source/licence: ../README.md.
import type { PlaceLevel } from '@aerial/contracts';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import data from './geometry.json' with { type: 'json' };

export type AreaProperties = { id: string; name: string; level: PlaceLevel };
export type AreaGeometry = FeatureCollection<Polygon | MultiPolygon, AreaProperties>;

/** Poltava oblast and its 4 raions; `properties.id` is the @aerial/geo place ID. */
export const AREA_GEOMETRY = data as unknown as AreaGeometry;

import type { AlertStateDto, IncidentListItem } from '@aerial/contracts';
import { AREA_GEOMETRY } from '@aerial/geo/geometry';
import {
  type FilterSpecification,
  type GeoJSONSource,
  Map as MapLibre,
  setWorkerUrl,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Areas } from './components';
import { ALERT_LABEL, areaAlertState, MAP_UNAVAILABLE, nearestArea } from './present';

// Bundled polygons on a plain background: no external tile provider (tiles stay an open item).
setWorkerUrl(workerUrl);

const GEOMETRY_IDS = new Set(AREA_GEOMETRY.features.map((f) => f.properties.id));
const COLORS = { active: '#dc2626', inactive: '#cbd5e1', unknown: '#9ca3af' };

function bounds(): [number, number, number, number] {
  const b: [number, number, number, number] = [180, 90, -180, -90];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      const [x, y] = c as [number, number];
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    } else c.forEach(visit);
  };
  for (const f of AREA_GEOMETRY.features) visit(f.geometry.coordinates);
  return b;
}
const BOUNDS = bounds();
const FIT = { padding: 12, animate: false };

/** 8x8 diagonal hatch: the "active" fill is readable without colour. */
function hatch() {
  const data = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if ((x + y) % 8 < 2) data.set([127, 29, 29, 255], (y * 8 + x) * 4);
    }
  }
  return { width: 8, height: 8, data };
}

const raion: FilterSpecification = ['==', ['get', 'level'], 'raion'];
const withState = (state: string): FilterSpecification => ['all', raion, ['==', ['get', 'state'], state]];

const STYLE: StyleSpecification = {
  version: 8,
  sources: { areas: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8fafc' } },
    {
      id: 'raion-fill',
      type: 'fill',
      source: 'areas',
      filter: raion,
      paint: {
        'fill-color': ['match', ['get', 'state'], 'active', COLORS.active, 'inactive', COLORS.inactive, COLORS.unknown],
        'fill-opacity': 0.45,
      },
    },
    { id: 'raion-outline', type: 'line', source: 'areas', filter: raion, paint: { 'line-color': '#334155', 'line-width': 1 } },
    {
      id: 'unknown-outline',
      type: 'line',
      source: 'areas',
      filter: withState('unknown'),
      paint: { 'line-color': '#1f2937', 'line-width': 2, 'line-dasharray': [2, 2] },
    },
    { id: 'active-outline', type: 'line', source: 'areas', filter: withState('active'), paint: { 'line-color': '#7f1d1d', 'line-width': 2.5 } },
    {
      id: 'reported-outline',
      type: 'line',
      source: 'areas',
      filter: ['==', ['get', 'reported'], true],
      paint: { 'line-color': '#1d4ed8', 'line-width': 4, 'line-offset': 2 },
    },
    {
      id: 'oblast-outline',
      type: 'line',
      source: 'areas',
      filter: ['==', ['get', 'level'], 'oblast'],
      paint: { 'line-color': '#0f172a', 'line-width': 2 },
    },
  ],
};

type Props = { alerts: readonly AlertStateDto[]; incidents: readonly IncidentListItem[]; areas: Areas };

export default function AreaMap({ alerts, incidents, areas }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [failed, setFailed] = useState(false);

  const features = useMemo(() => {
    // Only geography the text actually gives; channel defaults and unresolved places stay in the feed as text.
    const reported = new Set(
      incidents
        .filter((i) => i.areaId && (i.geoBasis === 'explicit' || i.geoBasis === 'reply_context'))
        .map((i) => nearestArea(areas, i.areaId!, GEOMETRY_IDS)),
    );
    return AREA_GEOMETRY.features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        state: areaAlertState(alerts, f.properties.id, areas.get(f.properties.id)?.parentId ?? null),
        reported: reported.has(f.properties.id),
      },
    }));
  }, [alerts, incidents, areas]);
  const data = useMemo(() => ({ type: 'FeatureCollection' as const, features }), [features]);
  const latest = useRef(data);
  latest.current = data;

  useEffect(() => {
    if (!container.current) return;
    let m: MapLibre;
    try {
      m = new MapLibre({
        container: container.current,
        style: STYLE,
        bounds: BOUNDS,
        fitBoundsOptions: FIT,
        interactive: false,
        attributionControl: false,
      });
    } catch {
      setFailed(true);
      return;
    }
    map.current = m;
    m.on('load', () => {
      m.addImage('hatch', hatch());
      m.addLayer(
        { id: 'active-hatch', type: 'fill', source: 'areas', filter: withState('active'), paint: { 'fill-pattern': 'hatch' } },
        'raion-outline',
      );
      m.getSource<GeoJSONSource>('areas')?.setData(latest.current);
    });
    m.on('resize', () => m.fitBounds(BOUNDS, FIT));
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (map.current?.isStyleLoaded()) map.current.getSource<GeoJSONSource>('areas')?.setData(data);
  }, [data]);

  const description = features
    .filter((f) => f.properties.level === 'raion')
    .map((f) => `${f.properties.name}: ${ALERT_LABEL[f.properties.state]}${f.properties.reported ? ', є повідомлення каналів' : ''}`)
    .join('; ');

  if (failed) {
    return <p className="pub-panel">{MAP_UNAVAILABLE}</p>;
  }
  return (
    <figure className="pub-map">
      <div ref={container} className="pub-map-canvas" role="img" aria-label={`Карта Полтавської області. ${description}.`} />
      <figcaption>
        <ul className="pub-legend" aria-label="Легенда карти">
          <li>
            <span className="swatch swatch-active" aria-hidden="true" /> Тривога за даними NEPTUN (червона штриховка)
          </li>
          <li>
            <span className="swatch swatch-inactive" aria-hidden="true" /> Тривоги немає за даними NEPTUN
          </li>
          <li>
            <span className="swatch swatch-unknown" aria-hidden="true" /> Невідомо або немає даних (пунктирна межа)
          </li>
          <li>
            <span className="swatch swatch-reported" aria-hidden="true" /> Район, названий у повідомленнях каналів (синій
            контур)
          </li>
        </ul>
        <p>Повідомлення без визначеного місця на карті не показано — вони є у стрічці.</p>
        <p className="pub-attribution">
          Межі: NEPTUN (neptun.in.ua), © OpenStreetMap contributors (ODbL).
        </p>
      </figcaption>
    </figure>
  );
}

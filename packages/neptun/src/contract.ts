// Runtime contract of NEPTUN `GET /api/v1/alerts` and the `/api/v1/stream` envelope (findings in ../README.md).
import { z } from 'zod';

const Instant = z.iso.datetime({ offset: true });

/** One raions[]/oblasts[] entry. Only `key` identifies the area, so only `key` is strict; drift elsewhere is a diagnostic. */
const AreaEntry = z.looseObject({ key: z.string().trim().min(1), since: z.unknown().optional(), level: z.unknown().optional() });

/** The list of areas under alert. Both arrays are required: without them the set is incomplete and nothing may be cleared. */
export const AlertsPayload = z.looseObject({ updatedAt: z.unknown().optional(), raions: z.array(AreaEntry), oblasts: z.array(AreaEntry) });

export const StreamEnvelope = z.looseObject({ type: z.string(), ts: z.unknown().optional(), data: z.unknown().optional() });
export type StreamEnvelope = z.infer<typeof StreamEnvelope>;

export const ALERT_LEVELS = ['red', 'yellow'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number] | 'unknown';

export type ActiveArea = { key: string; kind: 'raion' | 'oblast'; level: AlertLevel; since: Date | null };

/** A complete set: every area listed is under alert, every other area is not. */
export type AlertsSnapshot = {
  /** Provider `updatedAt`: time of the provider's last change (not fetch time). */
  providerTime: Date | null;
  areas: ActiveArea[];
  /** Tolerated schema drift (unknown enum values, unexpected fields); the snapshot is still usable. */
  diagnostics: string[];
};

export type ParseResult = { ok: true; snapshot: AlertsSnapshot } | { ok: false; error: string };

const PAYLOAD_FIELDS = new Set(['version', 'updatedAt', 'raions', 'oblasts']);
const ENTRY_FIELDS = new Set(['key', 'name', 'oblast', 'since', 'level', 'reasons']);

const instant = (v: unknown): Date | null => (Instant.safeParse(v).success ? new Date(v as string) : null);

/** Validates an alerts payload (REST body or WS `alerts` data). A valid empty set is `ok` with no areas. */
export function parseAlerts(json: unknown): ParseResult {
  const parsed = AlertsPayload.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const { raions, oblasts, updatedAt, ...rest } = parsed.data;
  const diagnostics: string[] = [];
  const unexpected = (fields: object, known: Set<string>, where: string) => {
    for (const f of Object.keys(fields)) if (!known.has(f)) diagnostics.push(`unexpected field "${f}" in ${where}`);
  };
  unexpected(rest, PAYLOAD_FIELDS, 'payload');

  const providerTime = instant(updatedAt);
  if (updatedAt !== undefined && !providerTime) diagnostics.push('invalid updatedAt');

  const areas = [
    ...raions.map((e) => [e, 'raion'] as const),
    ...oblasts.map((e) => [e, 'oblast'] as const),
  ].map(([e, kind]): ActiveArea => {
    unexpected(e, ENTRY_FIELDS, `${kind} entry`);
    const level = ALERT_LEVELS.find((l) => l === e.level) ?? 'unknown';
    if (level === 'unknown') diagnostics.push(`unknown level ${JSON.stringify(e.level)} for "${e.key}"`);
    const since = instant(e.since);
    if (e.since !== undefined && !since) diagnostics.push(`invalid since for "${e.key}"`);
    return { key: e.key, kind, level, since };
  });
  return { ok: true, snapshot: { providerTime, areas, diagnostics } };
}

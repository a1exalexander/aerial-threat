import type { Claim, ConnectorDto } from '@aerial/contracts';
import { describe, expect, it } from 'vitest';
import { readClaims } from '../../auth/session';
import { assessmentBasis, connectorStatus, formatAge, formatKyiv } from './labels';

const claim = (geoBasis: Claim['geoBasis'], classification: Claim['uncertainty']['classification'] = []) => ({
  geoBasis,
  uncertainty: { time: [], geo: [], classification },
});

describe('assessmentBasis', () => {
  const choice = (probabilities: Record<string, number>, selected = Object.keys(probabilities)[0]!) =>
    ({ type: 'choice', question: 'threat_type', selected, probabilities }) as const;

  it('confident answers are explicit, uncertain ones need review', () => {
    expect(assessmentBasis(choice({ uav: 0.95, missile: 0.03 }), claim('explicit'))).toBe('явна згадка');
    expect(assessmentBasis(choice({ uav: 0.7, missile: 0.2 }), claim('explicit'))).toBe('потребує перевірки');
    expect(assessmentBasis(choice({ uav: 0.92, missile: 0.8 }), claim('explicit'))).toBe('потребує перевірки');
    expect(assessmentBasis(choice({ uav: 0.02, unknown: 0.97 }, 'unknown'), claim('explicit'))).toBe('потребує перевірки');
    expect(assessmentBasis({ type: 'boolean', question: 'is_tentative', probability: 0.5 }, claim('explicit'))).toBe(
      'потребує перевірки',
    );
  });

  it('context-derived geography and context-dependent posts say so', () => {
    const place = { ...choice({ 'ua-pl-c-poltava': 0.95 }), question: 'place_candidate' };
    expect(assessmentBasis(place, claim('reply_context'))).toBe('визначено за контекстом');
    expect(assessmentBasis(place, claim('unresolved'))).toBe('потребує перевірки');
    expect(assessmentBasis(choice({ uav: 0.95 }), claim('explicit', ['needs_context']))).toBe('визначено за контекстом');
  });
});

describe('connectorStatus', () => {
  const now = '2026-09-21T10:00:00Z';
  const base: ConnectorDto = {
    id: '0199a000-0000-7000-8000-000000000001',
    provider: 'telegram',
    username: 'x',
    displayName: 'X',
    enabled: true,
    lastSuccessfulSync: '2026-09-21T09:59:50Z',
    lastMessageAt: '2026-09-21T09:58:00Z',
    availability: 'ok',
    lagMs: 100,
    errorKind: null,
  };

  it('tells channel silence apart from a connector failure', () => {
    expect(connectorStatus(base, now).label).toBe('Працює');
    expect(connectorStatus({ ...base, lastMessageAt: '2026-09-21T08:00:00Z' }, now).label).toBe('Тиша каналу — конектор працює');
    expect(connectorStatus({ ...base, errorKind: 'auth_lost' }, now).label).toBe('Збій конектора');
    expect(connectorStatus({ ...base, lastSuccessfulSync: null }, now).label).toBe('Стан невідомий');
    // A stalled connector that still claims "ok" is not a quiet channel.
    expect(connectorStatus({ ...base, lastSuccessfulSync: '2026-09-21T07:00:00Z', lastMessageAt: '2026-09-21T07:00:00Z' }, now).label).toBe(
      'Немає синхронізації понад 5 хв',
    );
    expect(connectorStatus({ ...base, enabled: false }, now).label).toBe('Призупинено');
    expect(connectorStatus({ ...base, provider: 'neptun', lastMessageAt: null }, now).label).toBe('Працює');
  });
});

it('formats ages and Kyiv time', () => {
  expect(formatAge(4_400)).toBe('4 с');
  expect(formatAge(75_000)).toBe('1 хв 15 с');
  expect(formatAge(3_720_000)).toBe('1 год 2 хв');
  expect(formatKyiv('2026-09-21T09:12:00Z')).toContain('12:12:00'); // UTC+3 in September
});

it('reads roles from a JWT and treats an opaque token as unknown roles', () => {
  const utf8 = new TextEncoder().encode(JSON.stringify({ sub: 'оператор', roles: ['reviewer', 'root'] }));
  const payload = btoa(String.fromCharCode(...utf8));
  expect(readClaims(`h.${payload}.s`)).toEqual({ subject: 'оператор', roles: ['reviewer'] });
  expect(readClaims('opaque-token')).toEqual({ subject: null, roles: null });
  expect(readClaims(`h.${btoa(JSON.stringify({ sub: 'x', realm_access: { roles: ['reviewer'] } }))}.s`).roles).toBeNull();
});

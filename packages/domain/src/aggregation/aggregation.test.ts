import { describe, expect, it } from 'vitest';
import {
  applyClaim,
  buildSummary,
  comparisonForm,
  findIncidentCandidates,
  groupingErrors,
  isAggregatable,
  matchOrigin,
  mergeIncidents,
  normalizeLink,
  refreshLifecycle,
  splitIncident,
  summaryText,
  withdrawClaims,
  type AggregationClaim,
  type Incident,
} from './index';

// Synthetic data only. Place IDs come from @aerial/geo; sources are two stand-in channels.
const ENERGY = 'src-energy';
const KREM = 'src-kremenchuk';
const KREMENCHUK = 'ua-pl-c-kremenchuk';
const POLTAVA = 'ua-pl-c-poltava';
const OBLAST = 'ua-pl';
const T0 = Date.parse('2026-09-14T11:30:00Z'); // 14:30 Kyiv
const at = (min: number) => new Date(T0 + min * 60_000);

let seq = 0;
function claim(over: Partial<AggregationClaim> = {}): AggregationClaim {
  const n = ++seq;
  const revisionId = over.revisionId ?? `rev-${n}`;
  return {
    id: `c${n}`,
    runId: `run-${n}`,
    revisionId,
    kind: 'threat_report',
    threatType: 'uav',
    threatQualifier: null,
    temporalScope: 'current',
    quantity: null,
    quantityText: null,
    placeId: KREMENCHUK,
    geoBasis: 'explicit',
    movementMention: null,
    evidence: [{ revisionId, start: 0, end: 5, rawStart: 0, rawEnd: 5 }],
    assessments: [],
    publicationDecision: 'publish',
    uncertainty: { time: [], geo: [], classification: [] },
    active: true,
    version: 1,
    sourceId: ENERGY,
    messageExternalId: String(1000 + n),
    publishedAt: at(0),
    mode: 'live',
    text: `синтетичний допис ${n}`,
    ...over,
  };
}

/** The pipeline in miniature: origin + candidates, optional relation answer, then apply. */
function feed(incidents: Incident[], c: AggregationClaim, now: Date, answer?: (ids: string[]) => string | null): Incident[] {
  const found = findIncidentCandidates(c, incidents);
  const picked = found.needsRelationQuestion ? (answer?.(found.candidates.map((x) => x.incidentId)) ?? null) : null;
  const targets = found.link.length ? found.link : picked ? [picked] : [];
  if (!targets.length) {
    const created = applyClaim(null, c, { reason: 'new', originGroup: found.originGroup, newIncidentId: `i${incidents.length + 1}` }, now);
    return [...incidents, created];
  }
  return incidents.map((i) => (targets.includes(i.id) ? applyClaim(i, c, { reason: 'linked', originGroup: found.originGroup }, now) : i));
}

const run = (claims: AggregationClaim[], now: Date) => claims.reduce<Incident[]>((acc, c) => feed(acc, c, now), []);
const INDEPENDENT_CONFIRMATION = /незалежн\S*\s+підтвердж/i;

describe('content copies (level 2)', () => {
  it('keeps negations, numbers and place names in the comparison form', () => {
    expect(comparisonForm('⚡️Вибухів НЕ чути, 2 БпЛА — на Кременчук!!')).toBe('вибухів не чути 2 бпла на кременчук');
    expect(comparisonForm('Вибухів не чути')).not.toBe(comparisonForm('Вибухи чути'));
    expect(comparisonForm('обʼєкт')).toBe(comparisonForm("об'єкт"));
    expect(comparisonForm('об´єкт')).toBe("об'єкт");
  });

  it('keys only Telegram post links; channel, invite and other site links are not one original post', () => {
    expect(normalizeLink('https://t.me/s/PoltavaODA/123?single')).toBe('t.me/poltavaoda/123');
    expect(normalizeLink('https://t.me/c/1234567/89')).toBe('t.me/c/1234567/89');
    expect(normalizeLink('t.me/poltavaoda/10/555')).toBe('t.me/poltavaoda/555');
    for (const link of ['t.me/poltavaoda', 't.me/joinchat/AAAA', 't.me/+AbCd', 'https://send.monobank.ua/jar/X1', 'https://www.youtube.com/watch?v=abc', 'not a url']) {
      expect(normalizeLink(link)).toBeNull();
    }
  });

  it('repost pair modelled on Energy 13810 / Кременчук 101889: one origin group, independence unknown', () => {
    const statement = 'Полтавська ОВА: у Кременчуці внаслідок атаки БпЛА пошкоджено 2 будинки, постраждалих немає.';
    const energy = claim({ kind: 'aftermath', temporalScope: 'past', text: `⚡️ ${statement}`, links: ['https://t.me/poltavaoda/5001'] });
    const krem = claim({ kind: 'aftermath', temporalScope: 'past', sourceId: KREM, text: statement, publishedAt: at(4) });
    const [incident, ...rest] = run([energy, krem], at(5));
    expect(rest).toHaveLength(0);
    expect(incident!.evidence.map((e) => e.originGroup)).toEqual([`${ENERGY}:${energy.messageExternalId}`, `${ENERGY}:${energy.messageExternalId}`]);
    expect(incident).toMatchObject({ sourceCount: 2, originGroupCount: 1, independence: 'unknown' });
    const text = summaryText(buildSummary(incident!));
    expect(text).toContain('одне спільне походження');
    expect(text).not.toMatch(INDEPENDENT_CONFIRMATION);
  });

  it('a shared link to the same original post is a copy even with different wording', () => {
    const a = claim({ links: ['https://t.me/poltavaoda/77'] });
    const b = claim({ sourceId: KREM, text: 'інший текст', links: ['t.me/PoltavaODA/77/'], publishedAt: at(30) });
    expect(matchOrigin(b, run([a], at(1)))).toEqual({ originGroup: `${ENERGY}:${a.messageExternalId}`, originBasis: 'shared_link' });
  });

  it('short identical texts from two channels are not treated as copies', () => {
    const a = claim({ text: 'БпЛА на Кременчук' });
    const b = claim({ sourceId: KREM, text: 'БпЛА на Кременчук', publishedAt: at(1) });
    expect(matchOrigin(b, run([a], at(1))).originBasis).toBe('new');
  });
});

describe('incident candidates (level 3)', () => {
  it('links a report of the same city from another channel within 15 minutes', () => {
    const incidents = run([claim(), claim({ sourceId: KREM, publishedAt: at(10) })], at(10));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.evidence[1]!.relation).toBe('supporting');
  });

  it('does not merge negative pairs in the same oblast', () => {
    expect(run([claim(), claim({ sourceId: KREM, placeId: POLTAVA, publishedAt: at(2) })], at(2))).toHaveLength(2);
    expect(run([claim(), claim({ sourceId: KREM, threatType: 'missile', publishedAt: at(2) })], at(2))).toHaveLength(2);
    expect(run([claim(), claim({ sourceId: KREM, publishedAt: at(16) })], at(16))).toHaveLength(2);
  });

  it('never auto-links on oblast plus «БпЛА» alone; broader/narrower is flagged and asked', () => {
    const incidents = run([claim()], at(0));
    const oblast = findIncidentCandidates(claim({ sourceId: KREM, placeId: OBLAST, publishedAt: at(3) }), incidents);
    expect(oblast.link).toEqual([]);
    expect(oblast.needsRelationQuestion).toBe(true);
    expect(oblast.candidates[0]!.reasons).toEqual(['broader_narrower', 'oblast_level_only']);

    const bothOblast = run([claim({ placeId: OBLAST })], at(0));
    const again = findIncidentCandidates(claim({ sourceId: KREM, placeId: OBLAST, publishedAt: at(3) }), bothOblast);
    expect(again).toMatchObject({ link: [], needsRelationQuestion: true });
  });

  it('asks the relation question when several incidents are compatible; a reply ranks first', () => {
    const parent = claim({ placeId: OBLAST });
    const incidents = run([claim({ sourceId: KREM, placeId: OBLAST }), parent], at(1));
    // Two oblast-level incidents exist only because the second never auto-linked to the first.
    expect(incidents).toHaveLength(2);
    const reply = claim({ placeId: OBLAST, replyToMessageId: parent.messageExternalId, publishedAt: at(2) });
    const found = findIncidentCandidates(reply, incidents);
    expect(found.needsRelationQuestion).toBe(true);
    expect(found.candidates[0]).toMatchObject({ incidentId: 'i2', strong: false });
    expect(found.candidates[0]!.reasons).toContain('reply_to_evidence');
  });

  it('an assumed (channel default) place never hides an explicit same-place match', () => {
    const incidents = run([claim({ geoBasis: 'channel_default' })], at(0));
    const withExplicit = feed(incidents, claim({ sourceId: KREM, publishedAt: at(1) }), at(1), (ids) => ids[0]!);
    const found = findIncidentCandidates(claim({ sourceId: 'src-third', publishedAt: at(2) }), withExplicit);
    expect(found).toMatchObject({ link: ['i1'], needsRelationQuestion: false });
  });

  it('the incident area is the most specific of nested places', () => {
    const incidents = feed(run([claim({ placeId: OBLAST })], at(0)), claim({ sourceId: KREM, publishedAt: at(1) }), at(1), (ids) => ids[0]!);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.areaId).toBe(KREMENCHUK);
    expect(summaryText(buildSummary(incidents[0]!))).toContain('Територія: Кременчук, Полтавська область.');
  });

  it('a sibling claim of a multi-place post does not follow its origin into another place', () => {
    const first = claim();
    const sibling = claim({ messageExternalId: first.messageExternalId, runId: first.runId, revisionId: first.revisionId, placeId: POLTAVA });
    expect(run([first, sibling], at(0))).toHaveLength(2);
  });

  it('links aftermath within 24 h only on the same mentioned event date', () => {
    const base = claim({ kind: 'aftermath', temporalScope: 'past', eventDate: '2026-09-14' });
    const incidents = run([base], at(0));
    const same = claim({ kind: 'aftermath', temporalScope: 'past', sourceId: KREM, eventDate: '2026-09-14', publishedAt: at(300) });
    const other = claim({ kind: 'aftermath', temporalScope: 'past', sourceId: KREM, eventDate: '2026-09-13', publishedAt: at(300) });
    expect(findIncidentCandidates(same, incidents).link).toEqual(['i1']);
    expect(findIncidentCandidates(other, incidents).candidates).toEqual([]);
  });

  it('keeps uncertain claims as separate candidate incidents instead of dropping them', () => {
    const vague = claim({ placeId: null, geoBasis: 'unresolved', publicationDecision: 'review' });
    expect(isAggregatable(vague)).toBe(true);
    expect(isAggregatable(claim({ kind: 'fundraising' }))).toBe(false);
    expect(isAggregatable(claim({ publicationDecision: 'exclude' }))).toBe(false);
    const incidents = run([claim(), vague], at(0));
    expect(incidents).toHaveLength(2);
    expect(incidents[1]!.lifecycle).toBe('candidate');
    expect(summaryText(buildSummary(incidents[1]!))).toContain('Місце не визначено.');
  });
});

describe('conflicts', () => {
  it('keeps 2 vs 3 from different channels as variants, never averaged or summed', () => {
    const [incident] = run([claim({ quantity: 2 }), claim({ sourceId: KREM, quantity: 3, publishedAt: at(3) })], at(3));
    expect(incident!.hasConflict).toBe(true);
    expect(incident!.evidence.map((e) => [e.claim.quantity, e.relation])).toEqual([
      [2, 'primary'],
      [3, 'conflicting'],
    ]);
    const text = summaryText(buildSummary(incident!));
    expect(text).toContain('Кількість різниться між каналами: 2 або 3; значення не сумуються.');
    expect(text).not.toMatch(/\b(5|2[.,]5)\b/);
  });

  it("a channel's own update is not a conflict", () => {
    const [incident] = run([claim({ quantity: 2 }), claim({ quantity: 3, publishedAt: at(3) })], at(3));
    expect(incident!.hasConflict).toBe(false);
    expect(summaryText(buildSummary(incident!))).toContain('Кількість за повідомленням: 3.');
  });
});

describe('edits and recompute', () => {
  it('a late edit that changes geography moves membership and keeps the old evidence for audit', () => {
    const original = claim();
    let incidents = run([original, claim({ sourceId: KREM, publishedAt: at(2) })], at(2));
    const edited = claim({ messageExternalId: original.messageExternalId, placeId: POLTAVA, publishedAt: original.publishedAt });
    incidents = incidents.map((i) => withdrawClaims(i, [original.id], 'edited: new revision', at(8)));
    incidents = feed(incidents, edited, at(8));
    expect(incidents).toHaveLength(2);
    const [krem, poltava] = incidents;
    expect(krem).toMatchObject({ areaId: KREMENCHUK, sourceCount: 1, revision: 3 });
    expect(krem!.evidence[0]).toMatchObject({ active: false, reason: 'new; withdrawn: edited: new revision' });
    expect(poltava).toMatchObject({ areaId: POLTAVA, lifecycle: 'reported' });
  });

  it('a reprocess run replaces its predecessor via withdraw + apply', () => {
    const first = claim({ quantity: 2 });
    let incidents = run([first], at(0));
    const rerun = claim({ messageExternalId: first.messageExternalId, quantity: 4 });
    incidents = feed(incidents.map((i) => withdrawClaims(i, [first.id], 'superseded by reprocess', at(1))), rerun, at(1));
    // The withdrawn predecessor retracted its incident, so the successor opens a new one.
    expect(incidents.map((i) => i.lifecycle)).toEqual(['retracted', 'reported']);
    expect(incidents[1]!.evidence[0]!.originGroup).toBe(`${ENERGY}:${first.messageExternalId}`);
    expect(summaryText(buildSummary(incidents[1]!))).toContain('Кількість за повідомленням: 4.');
  });

  it('is idempotent per claim ID and version (level 1), also after a withdrawal', () => {
    const c = claim({ quantity: 2 });
    const [incident] = run([c], at(0));
    const decision = { reason: 'again', originGroup: incident!.evidence[0]!.originGroup };
    expect(applyClaim(incident!, c, decision, at(1))).toBe(incident);
    const newer = applyClaim(incident!, { ...c, version: 2, quantity: 5 }, decision, at(1));
    expect(newer.evidence.map((e) => [e.claim.version, e.claim.quantity])).toEqual([[2, 5]]);
    expect(applyClaim(newer, c, decision, at(2))).toBe(newer); // a late older version never wins
    const withdrawn = withdrawClaims(newer, [c.id], 'operator excluded', at(2));
    expect(applyClaim(withdrawn, { ...c, version: 2, quantity: 5 }, decision, at(3))).toBe(withdrawn);
  });

  it('routes a redelivered claim back to its incident, even without a place', () => {
    const vague = claim({ placeId: null, geoBasis: 'unresolved', publicationDecision: 'review' });
    const incidents = run([vague], at(0));
    expect(findIncidentCandidates(vague, incidents)).toMatchObject({ link: ['i1'], needsRelationQuestion: false });
    expect(feed(incidents, vague, at(1))).toEqual(incidents);
  });

  it('withdrawing every claim retracts the incident with an empty summary (never «safe»)', () => {
    const [incident] = run([claim()], at(0));
    const retracted = withdrawClaims(incident!, ['c-missing', incident!.evidence[0]!.claim.id], 'deleted by source', at(1));
    expect(retracted.lifecycle).toBe('retracted');
    expect(buildSummary(retracted)).toEqual([]);
  });
});

describe('lifecycle with an injected clock', () => {
  it('reported → stale after 15 min → archived after 60 min', () => {
    const [incident] = run([claim()], at(0));
    expect(incident!.lifecycle).toBe('reported');
    const stale = refreshLifecycle(incident!, at(15));
    expect(stale).toMatchObject({ lifecycle: 'stale', revision: 2 });
    expect(refreshLifecycle(stale, at(20))).toBe(stale);
    expect(refreshLifecycle(stale, at(60)).lifecycle).toBe('archived');
  });

  it('review-only incidents stay candidates until archived; aftermath goes straight to history', () => {
    const [review] = run([claim({ publicationDecision: 'review' })], at(0));
    expect(refreshLifecycle(review!, at(30)).lifecycle).toBe('candidate');
    expect(refreshLifecycle(review!, at(60)).lifecycle).toBe('archived');
    expect(run([claim({ kind: 'aftermath', temporalScope: 'past' })], at(0))[0]!.lifecycle).toBe('archived');
  });

  it('a delayed live delivery does not make an old post fresh', () => {
    const [late] = run([claim({ publishedAt: at(-20) })], at(0));
    expect(late!.lifecycle).toBe('stale');
    expect(late!.lastEvidenceAt).toEqual(at(-20));
  });
});

describe('closure claims', () => {
  it("ends the channel's episode via TTL only and yields no alert-state output while the API is active", () => {
    let incidents = run([claim(), claim({ sourceId: KREM, publishedAt: at(1) })], at(1));
    const clear = claim({ kind: 'clear_claim', publishedAt: at(5), text: 'Відбій загрози для Кременчука' });
    const found = findIncidentCandidates(clear, incidents);
    expect(found).toMatchObject({ link: ['i1'], needsRelationQuestion: false });
    incidents = feed(incidents, clear, at(5));
    const [closed] = incidents;
    expect(closed).toMatchObject({ closureClaimId: clear.id, lifecycle: 'reported', lastEvidenceAt: at(1) });
    expect(closed!.evidence.at(-1)!.relation).toBe('closure');
    expect(Object.keys(closed!).filter((k) => /alert|safe/i.test(k))).toEqual([]);
    expect(refreshLifecycle(closed!, at(16)).lifecycle).toBe('stale');
    expect(refreshLifecycle(closed!, at(61)).lifecycle).toBe('archived');
    const text = summaryText(buildSummary(closed!));
    expect(text).toContain('Канал повідомив про відбій о 14:35 — це твердження каналу, а не офіційний стан тривоги.');
    expect(text).not.toMatch(/безпечн|загрози немає|небезпеки немає|тривоги немає|все чисто/i);

    // After its own closure a channel's new report starts a new episode; another channel's closure is its own incident.
    expect(findIncidentCandidates(claim({ publishedAt: at(7) }), incidents).candidates).toEqual([]);
    const other = feed(run([claim()], at(0)), claim({ kind: 'clear_claim', sourceId: KREM, publishedAt: at(2) }), at(2));
    expect(other.map((i) => i.kind)).toEqual(['threat_report', 'clear_claim']);
    expect(other[0]!.closureClaimId).toBeNull();
  });

  it('a late-delivered closure does not close reports published after it', () => {
    let incidents = run([claim(), claim({ publishedAt: at(12) })], at(12));
    incidents = feed(incidents, claim({ kind: 'clear_claim', publishedAt: at(10) }), at(13));
    expect(incidents).toHaveLength(1);
    // The channel reported again at 12 after its «відбій» at 10: the episode is open, the closure is not current.
    expect(incidents[0]!.closureClaimId).toBeNull();
    expect(findIncidentCandidates(claim({ publishedAt: at(14) }), incidents).link).toEqual(['i1']);
  });
});

describe('merge and split', () => {
  it('merge preserves evidence and reasons; split moves claims back out', () => {
    const [a, b] = run([claim(), claim({ sourceId: KREM, placeId: POLTAVA })], at(0));
    const merged = mergeIncidents(a!, b!, 'operator: same wave', at(1));
    expect(merged.target.evidence.map((e) => [e.claim.id, e.active])).toEqual([
      [a!.evidence[0]!.claim.id, true],
      [b!.evidence[0]!.claim.id, true],
    ]);
    expect(merged.target.evidence[1]!.reason).toBe('new; merged from i2: operator: same wave');
    expect(merged.target).toMatchObject({ hasConflict: true, revision: 2 });
    expect(merged.source).toMatchObject({ lifecycle: 'retracted', revision: 2 });
    expect(merged.source.evidence[0]!.active).toBe(false);

    const { original, split } = splitIncident(merged.target, [b!.evidence[0]!.claim.id], 'i3', 'operator: different city', at(2));
    expect(original).toMatchObject({ hasConflict: false, areaId: KREMENCHUK, revision: 3 });
    expect(split).toMatchObject({ id: 'i3', areaId: POLTAVA, revision: 1, lifecycle: 'reported' });
    expect(split.evidence[0]!.reason).toContain('split from i1: operator: different city');
    expect(() => mergeIncidents(a!, { ...b!, mode: 'archive' }, 'x', at(1))).toThrow();
    expect(() => mergeIncidents(a!, { ...b!, kind: 'aftermath' }, 'x', at(1))).toThrow();

    // Merging back keeps the target's earlier (split) history in the reason.
    const back = mergeIncidents(original, split, 'operator: undo split', at(3));
    expect(back.target.evidence.find((e) => e.claim.id === b!.evidence[0]!.claim.id)!.reason).toMatch(
      /split into i3.*merged from i3: operator: undo split$/,
    );
  });
});

describe('summary', () => {
  it('follows the template and drops a sentence when its claim is removed', () => {
    const moving = claim({ movementMention: 'курсом на Кременчук', quantity: 2 });
    const [incident] = run([moving, claim({ sourceId: KREM, publishedAt: at(2) })], at(2));
    const sentences = buildSummary(incident!);
    expect(summaryText(sentences)).toBe(
      'Територія: Кременчук. Напрямок за текстом: курсом на Кременчук. 2 канали повідомляють про БпЛА. ' +
        'Кількість за повідомленням: 2. Місце визначено з тексту. Оновлено о 14:32. ' +
        'Джерела: 2 канали; незалежність не встановлена.',
    );
    const ids = new Set(incident!.evidence.map((e) => e.claim.id));
    expect(sentences.every((s) => s.claimIds.length > 0 && s.claimIds.every((id) => ids.has(id)))).toBe(true);

    const rebuilt = buildSummary(withdrawClaims(incident!, [moving.id], 'excluded by operator', at(3)));
    expect(rebuilt.some((s) => s.claimIds.includes(moving.id))).toBe(false);
    expect(summaryText(rebuilt)).toBe(
      'Територія: Кременчук. Канал повідомляє про БпЛА. Місце визначено з тексту. Оновлено о 14:32.',
    );
  });
});

describe('grouping metrics', () => {
  it('counts pairwise false merges and false splits', () => {
    const predicted = new Map([['a', '1'], ['b', '1'], ['c', '1'], ['d', '2']]);
    const expected = new Map([['a', 'x'], ['b', 'x'], ['c', 'y'], ['d', 'y']]);
    expect(groupingErrors(predicted, expected)).toEqual({
      falseMerge: { numerator: 2, denominator: 3 },
      falseSplit: { numerator: 1, denominator: 2 },
    });
    // A dropped claim is a false split, not a skipped pair.
    expect(groupingErrors(new Map([['a', '1']]), new Map([['a', 'x'], ['b', 'x']])).falseSplit).toEqual({ numerator: 1, denominator: 1 });
  });
});

import type { SituationResponse } from '@aerial/contracts';
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../mocks/node';
import { buildSituation, SCENARIO_KEY, type Scenario } from '../../mocks/situation/handlers';
import { MAX_AGE_MS } from './api';
import SituationScreen from './SituationScreen';

const SAFE_WORDING = /загроз\S* немає|безпечно|все спокійно|небезпеки немає/i;

function open(scenario: Scenario) {
  localStorage.setItem(SCENARIO_KEY, scenario);
  return render(<SituationScreen />);
}
function serve(body: SituationResponse) {
  server.use(http.get('*/v1/situation', () => HttpResponse.json(body)));
  return render(<SituationScreen />);
}
const tile = () => screen.findByRole('region', { name: 'Стан тривоги' });
const statuses = () => screen.getByRole('region', { name: 'За даними каналів' });

afterEach(() => localStorage.clear());

describe('alert tile', () => {
  it.each([
    ['alert-shahed', 'ТРИВОГА', 'siren'],
    ['threat-no-alert', 'ЗАГРОЗА', 'warning'],
    ['clear', 'ВІДБІЙ', 'shield'],
    ['unknown', 'НЕВІДОМО', 'question'],
  ] as const)('%s renders %s with its icon', async (scenario, label, icon) => {
    open(scenario);
    const t = await tile();
    expect(within(t).getByRole('heading', { name: label })).toBeTruthy();
    expect(t.querySelector(`svg[data-icon="${icon}"]`)).not.toBeNull();
  });

  it('alert shows since and the NEPTUN level as text', async () => {
    open('alert-shahed');
    const t = await tile();
    expect(within(t).getByText(/червоний рівень/)).toBeTruthy();
    expect(t.querySelector('time')).not.toBeNull();
  });

  it('threat without an alert is attributed to the channels', async () => {
    open('threat-no-alert');
    const t = await tile();
    expect(within(t).getByText('ЗАГРОЗА')).toBeTruthy();
    expect(within(t).getByText('за даними каналів, офіційної тривоги немає')).toBeTruthy();
    expect(screen.getByText('Канали: очікується тривога')).toBeTruthy();
  });

  it('unknown never shows green, even when the channels report a threat', async () => {
    const { container } = open('unknown');
    const t = await tile();
    expect(within(t).getByText('немає свіжих даних NEPTUN')).toBeTruthy();
    expect(container.querySelector('.tile--clear, .tile--threat')).toBeNull();
    expect(screen.queryByText('ВІДБІЙ')).toBeNull();
  });

  it('API unavailable shows НЕВІДОМО, never clear', async () => {
    server.use(http.get('*/v1/situation', () => HttpResponse.json({ code: 'x', requestId: 'r', message: 'm' }, { status: 503 })));
    render(<SituationScreen />);
    const t = await within(await tile()).findByText('НЕВІДОМО');
    expect(t).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/стан тривоги невідомий/);
    expect(screen.queryByText('дані застарілі')).toBeNull(); // nothing old is shown
    expect(screen.getByText('Немає даних')).toBeTruthy();
  });

  it('stale data is labelled', async () => {
    open('stale');
    expect(within(await tile()).getByText('дані застарілі')).toBeTruthy();
    expect(within(statuses()).getByText('дані застарілі')).toBeTruthy();
  });

  it('a threat tile backed by a stale analysis carries the stale badge', async () => {
    open('eval-stale');
    const t = await tile();
    expect(within(t).getByText('ЗАГРОЗА')).toBeTruthy();
    expect(within(t).getByText('дані застарілі')).toBeTruthy();
  });
});

describe('statuses', () => {
  it('shows the channel statuses with labels and hides confident negatives', async () => {
    open('alert-shahed');
    await tile();
    const s = screen.getByRole('region', { name: 'За даними каналів' });
    expect(within(s).getByText('Шахед')).toBeTruthy();
    expect(within(s).getByText('Курс на Кременчук')).toBeTruthy();
    expect(within(s).getByText('Аналіз: AI', { exact: false })).toBeTruthy();

    // «на воду» closes the route; a stop in Кременчуцький район is highlighted.
    const chips = within(s).getAllByRole('listitem').filter((li) => li.closest('.route-list'));
    expect(chips.map((li) => li.textContent)).toEqual(['Козельщина', '→Кременчук (Кременчуцький район)', '→Градизьк', '→на воду']);
    expect(within(s).getByText('Кременчук').closest('.chip--raion')).not.toBeNull();
  });

  it('marks low confidence and names the rules mode', async () => {
    open('ai-off');
    await tile();
    const s = screen.getByRole('region', { name: 'За даними каналів' });
    expect(within(s).getAllByText('ймовірно').length).toBe(3);
    expect(within(s).getByText('Курс на Кременчук').closest('.stat--low')).not.toBeNull();
    expect(within(s).getByText(/Аналіз: правила/)).toBeTruthy();
  });

  it('forecast is a separate channel-attributed chip', async () => {
    open('alert-ballistic');
    await tile();
    expect(screen.getByText('Балістика')).toBeTruthy();
    expect(screen.getByText('Канали: очікується відбій').closest('.forecast')).not.toBeNull();
    expect(screen.queryByText('Робота ППО')).toBeNull(); // confident "no" is hidden
  });

  it('stale analysis: statuses stay visible but muted and labelled', async () => {
    const { container } = open('eval-stale');
    await tile();
    expect(within(statuses()).getByText('Реактивний шахед')).toBeTruthy();
    expect(within(statuses()).getByText('дані застарілі')).toBeTruthy();
    expect(container.querySelector('.sit-statuses--stale')).not.toBeNull();
  });

  it('analysis of unknown freshness never renders status values as current', async () => {
    open('eval-unknown');
    await tile();
    const s = statuses();
    expect(within(s).getByText('Аналіз застарів — статуси не показано.')).toBeTruthy();
    expect(within(s).getByText(/Аналіз: AI/).querySelector('time')).not.toBeNull();
    for (const value of ['Реактивний шахед', 'Пролітає повз', '2', 'Канали: очікується тривога', 'Омельник']) {
      expect(within(s).queryByText(value)).toBeNull();
    }
    expect(within(s).queryByRole('list')).toBeNull();
    expect(screen.queryByText('доказ')).toBeNull();
    expect(screen.getAllByRole('article').length).toBe(3); // the posts themselves are still shown
  });

  it('all-negative statuses are neutral, never «загроз немає»', async () => {
    open('clear');
    await tile();
    expect(screen.getByText(/деталей не знайдено/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(SAFE_WORDING);
  });
});

describe('feed', () => {
  it('shows posts newest first with time, edit mark, reply context, evidence and link', async () => {
    open('alert-shahed');
    await tile();
    const feed = screen.getByRole('region', { name: 'Повідомлення каналів' });
    const posts = within(feed).getAllByRole('article');
    expect(posts).toHaveLength(5);
    expect(posts[0]!.textContent).toMatch(/курс на Кременчук/);
    expect(within(posts[0]!).getByText('доказ')).toBeTruthy();
    expect(within(posts[1]!).getByText('Де він зараз?')).toBeTruthy();
    expect(within(posts[1]!).queryByText('доказ')).toBeNull();
    expect(within(posts[3]!).getByText('змінено')).toBeTruthy();
    const link = within(posts[0]!).getByRole('link', { name: /Відкрити в Telegram/ });
    expect(link.getAttribute('href')).toBe('https://t.me/demo_kremenchuk_channel/9001');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(posts[4]!).queryByRole('link')).toBeNull(); // link: null
  });

  it('empty feed is neutral and never says safe', async () => {
    open('empty-feed');
    await tile();
    expect(screen.getByText('Немає повідомлень за останні години.')).toBeTruthy();
    expect(screen.getByText('Аналіз ще не виконано.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(SAFE_WORDING);
  });

  it('renders markup in post text as plain text and drops non-t.me links', async () => {
    const body = buildSituation('clear');
    body.data.feed[0] = { ...body.data.feed[0]!, text: '<script>alert("xss")</script>', link: 'https://evil.example/x' };
    const { container } = serve(body);
    expect(await screen.findByText('<script>alert("xss")</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getAllByRole('article')[0]!.querySelector('a')).toBeNull();
  });
});

it('footer carries NEPTUN attribution and the disclaimer; header shows the update time', async () => {
  open('clear');
  await tile();
  expect(screen.getByRole('link', { name: 'NEPTUN' }).getAttribute('href')).toBe('https://neptun.in.ua/');
  expect(screen.getByText('Агрегатор не замінює офіційне оповіщення.')).toBeTruthy();
  expect(screen.getByText(/^Оновлено о/).textContent).toMatch(/^Оновлено о \d{2}:\d{2}:\d{2}$/);
});

it('keeps the last data with a warning when a refresh fails', async () => {
  open('alert-shahed');
  await tile();
  server.use(http.get('*/v1/situation', () => HttpResponse.json({ code: 'x', requestId: 'r', message: 'm' }, { status: 503 })));
  document.dispatchEvent(new Event('visibilitychange'));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Оновлення не вдалося/);
  expect(within(await tile()).getByText('ТРИВОГА')).toBeTruthy();
  expect(within(await tile()).getByText('дані застарілі')).toBeTruthy();
});

it('with no successful check for too long, the last tile gives way to НЕВІДОМО', async () => {
  open('clear');
  expect(within(await tile()).getByText('ВІДБІЙ')).toBeTruthy();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + MAX_AGE_MS + 1_000);
  try {
    server.use(http.get('*/v1/situation', () => HttpResponse.error()));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await within(await tile()).findByText('НЕВІДОМО')).toBeTruthy();
    expect(screen.queryByText('ВІДБІЙ')).toBeNull();
    expect(screen.getAllByRole('article').length).toBeGreaterThan(0); // last posts stay, under the warning banner
  } finally {
    vi.restoreAllMocks();
  }
});

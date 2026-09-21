import { act, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { INCIDENT_IDS, type Scenario } from '../../mocks/public/data';
import { SCENARIO_KEY } from '../../mocks/public/handlers';
import { server } from '../../mocks/node';
import { routes } from '../../routes';

const SAFE_WORDING = /загроз\S* немає|безпечно|все спокійно|небезпеки немає/i;

function open(path: string, scenario: Scenario = 'fresh') {
  localStorage.setItem(SCENARIO_KEY, scenario);
  return render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />);
}
const section = (name: RegExp | string) => screen.getByRole('region', { name });

afterEach(() => localStorage.clear());

describe('overview', () => {
  it('shows NEPTUN state with attribution, and a channel all-clear next to the still-active alert', async () => {
    open('/');
    const alerts = await screen.findByRole('region', { name: 'Стан тривоги за даними NEPTUN' });
    expect(within(alerts).getByText('Тривога')).toBeTruthy();
    expect(within(alerts).getByRole('link', { name: /NEPTUN/ }).getAttribute('href')).toBe('https://neptun.in.ua/');
    expect(within(alerts).getByText(/не замінює офіційне оповіщення/)).toBeTruthy();

    const feed = section('Повідомлення каналу');
    expect(within(feed).getByText(/Канал повідомив про відбій — стан тривоги NEPTUN цим не змінюється/)).toBeTruthy();
    expect(within(feed).getAllByText(/Оцінка автоматичного розбору/).length).toBeGreaterThan(0);
    // Unresolved geography is a text card, not a guessed place.
    expect(within(feed).getAllByText('Місце не визначено').length).toBe(1);
  });

  it('empty feed is neutral and never reads as safe', async () => {
    open('/', 'empty');
    expect(await screen.findByText(/Немає отриманих повідомлень за період/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(SAFE_WORDING);
  });

  it('NEPTUN unavailable shows «Невідомо», never "no alert"', async () => {
    open('/', 'neptun-down');
    const alerts = await screen.findByRole('region', { name: 'Стан тривоги за даними NEPTUN' });
    expect(within(alerts).getAllByText('Невідомо').length).toBe(5);
    expect(within(alerts).queryByText('Тривоги немає')).toBeNull();
  });

  it('stale snapshot is labelled', async () => {
    open('/', 'stale');
    expect((await screen.findAllByText('Дані застарілі')).length).toBeGreaterThan(0);
  });

  it('failed load says the alert state is unknown and offers a retry', async () => {
    open('/', 'error');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/NEPTUN — невідомо/)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Спробувати ще раз' })).toBeTruthy();
  });
});

describe('incident details', () => {
  it('renders post text as plain text and links to the original post', async () => {
    open(`/incidents/${INCIDENT_IDS.uav}`);
    const evidence = await screen.findByRole('region', { name: 'Повідомлення каналу' });
    expect(within(evidence).getByText(/<script>alert\("xss"\)<\/script>/)).toBeTruthy();
    expect(document.querySelector('.pub script')).toBeNull();
    const link = within(evidence).getAllByRole('link', { name: /Відкрити допис у Telegram/ })[0]!;
    expect(link.getAttribute('href')).toBe('https://t.me/demo_kremenchuk_channel/900101');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows explicit vs context geography', async () => {
    open(`/incidents/${INCIDENT_IDS.missile}`);
    const evidence = await screen.findByRole('region', { name: 'Повідомлення каналу' });
    expect(within(evidence).getByText('Місце взято з контексту відповіді')).toBeTruthy();
    expect(within(evidence).getByText('Місце названо в тексті')).toBeTruthy();
  });

  it('keeps the last NEPTUN reading with a stale note when its refresh fails', async () => {
    open(`/incidents/${INCIDENT_IDS.uav}`);
    const alerts = await screen.findByRole('region', { name: 'Стан тривоги за даними NEPTUN' });
    await within(alerts).findByText('Тривога');

    server.use(http.get('*/v1/alerts', () => HttpResponse.json({ code: 'x', requestId: 'r', message: 'm' }, { status: 503 })));
    act(() => document.dispatchEvent(new Event('visibilitychange'))); // visible tab -> immediate poll
    expect(await within(alerts).findByText(/Оновлення стану тривоги не вдалося/)).toBeTruthy();
    expect(within(alerts).getByText('Тривога')).toBeTruthy();
  });

  it('shows conflicts without averaging', async () => {
    open(`/incidents/${INCIDENT_IDS.uav}`, 'conflict');
    const conflicts = await screen.findByRole('region', { name: 'Суперечності' });
    expect(within(conflicts).getByText(/не усереднюються/)).toBeTruthy();
    expect(within(conflicts).getByText('5 БпЛА курсом на Кременчук.')).toBeTruthy();
    expect(screen.getByText('Суперечливі дані в джерелах')).toBeTruthy();
  });
});

describe('history', () => {
  it('is visibly an archive and requests asOf', async () => {
    open('/history?at=2026-09-20T14:30&area=ua-pl');
    expect(screen.getByRole('heading', { level: 1, name: 'Історія (архів)' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/АРХІВНИЙ РЕЖИМ/);
    // 14:30 Kyiv (EEST) = 11:30Z goes out as asOf and comes back as the snapshot time.
    expect(await screen.findByRole('heading', { name: 'Стан тривоги за даними NEPTUN на 20.09.2026, 14:30:00' })).toBeTruthy();
    expect(screen.getAllByText('Архівний запис').length).toBeGreaterThan(0);
    expect(screen.getByRole('status').textContent).toMatch(/Архівні дані/);
  });
});

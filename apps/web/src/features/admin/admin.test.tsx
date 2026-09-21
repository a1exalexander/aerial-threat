import { fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { signOut } from '../../auth/session';
import { ADMIN_MOCK_KEY, resetAdminMocks } from '../../mocks/admin/handlers';
import { server } from '../../mocks/node';
import Ops from '../../routes/ops';
import Review from '../../routes/review';

const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload: object) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
const UUID = /^[0-9a-f-]{36}$/;

function open(path: string, token = jwt({ sub: 'op-1', roles: ['reviewer'] })) {
  const router = createMemoryRouter(
    [
      { path: '/review', element: <Review /> },
      { path: '/ops', element: <Ops /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  expect(screen.getByRole('heading', { level: 1, name: /: потрібен вхід$/ })).toBeTruthy(); // logged-out state first
  fireEvent.change(screen.getByLabelText('Bearer-токен'), { target: { value: token } });
  fireEvent.click(screen.getByRole('button', { name: 'Увійти з токеном' }));
}

/** Records review POST bodies and lets the default mock handler answer. */
function captureReviews() {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post('*/v1/admin/claims/:id/review', async ({ request }) => {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }),
  );
  return bodies;
}

const firstCard = async () => (await screen.findAllByRole('article'))[0]!;
const decide = (card: HTMLElement, reason: string) => {
  fireEvent.change(within(card).getByLabelText("Причина (обов'язково, потрапляє до аудиту)"), { target: { value: reason } });
  fireEvent.click(within(card).getByRole('button', { name: 'Надіслати рішення' }));
};

beforeEach(() => {
  signOut();
  localStorage.clear();
  resetAdminMocks();
});

describe('operator auth', () => {
  it('shows the logged-out state, then the queue after a dev token login', async () => {
    open('/review');
    expect(await screen.findByRole('heading', { level: 1, name: 'Перевірка' })).toBeTruthy();
    expect(await screen.findAllByRole('article')).toHaveLength(3);
    expect(screen.getByText(/Оператор:/).textContent).toContain('op-1');
  });

  it('401 drops the session and asks to log in again', async () => {
    server.use(
      http.get('*/v1/admin/review', () => HttpResponse.json({ code: 'unauthorized', requestId: 'r', message: 'no' }, { status: 401 })),
    );
    open('/review');
    expect(await screen.findByText('Сесія завершилась або токен недійсний. Увійдіть знову.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Перевірка: потрібен вхід' })).toBeTruthy();
  });

  it('a 401 on submit asks to log in again and keeps the draft', async () => {
    server.use(
      http.post('*/v1/admin/claims/:id/review', () => HttpResponse.json({ code: 'x', requestId: 'r', message: 'x' }, { status: 401 }), {
        once: true,
      }),
    );
    open('/review');
    decide(await firstCard(), 'Підтверджую за джерелом');
    expect(await screen.findByText('Сесія завершилась або токен недійсний. Увійдіть знову.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Bearer-токен'), { target: { value: jwt({ sub: 'op-1', roles: ['reviewer'] }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Увійти з токеном' }));
    const reason = within(await firstCard()).getByLabelText<HTMLTextAreaElement>("Причина (обов'язково, потрапляє до аудиту)");
    expect(reason.value).toBe('Підтверджую за джерелом');
  });

  it('403 shows the permission-denied state', async () => {
    localStorage.setItem(ADMIN_MOCK_KEY, 'forbidden');
    open('/ops');
    expect(await screen.findByRole('heading', { name: 'Доступ заборонено' })).toBeTruthy();
    expect(screen.queryByText('Черга завдань')).toBeNull();
  });

  it('a viewer token sees the queue without decision controls', async () => {
    open('/review', jwt({ sub: 'viewer-1', roles: ['viewer'] }));
    const card = await firstCard();
    expect(within(card).queryByRole('button', { name: 'Надіслати рішення' })).toBeNull();
    expect(within(card).getByText(/лише перегляд/)).toBeTruthy();
  });
});

describe('review', () => {
  it('renders reasons instead of probabilities', async () => {
    open('/review');
    const card = await firstCard();
    const place = within(card).getByRole('row', { name: /Місце/ });
    expect(place.textContent).toContain('потребує перевірки');
    expect(within(card).getByRole('row', { name: /Тип загрози/ }).textContent).toContain('явна згадка');
    expect(card.textContent).not.toMatch(/0[.,]\d|%/);
  });

  it('a correction sends expectedVersion, a fresh idempotencyKey and the reason', async () => {
    const bodies = captureReviews();
    open('/review');
    const card = await firstCard();
    fireEvent.click(within(card).getByLabelText('Виправити категорію чи географію'));
    fireEvent.change(within(card).getByLabelText('Загроза'), { target: { value: 'missile' } });
    decide(card, 'У тексті ракета, не БпЛА');

    expect(await screen.findByText('Виправлення збережено.')).toBeTruthy();
    expect(bodies).toEqual([
      {
        action: 'correct',
        expectedVersion: 1,
        reason: 'У тексті ракета, не БпЛА',
        correction: { threatType: 'missile' },
        idempotencyKey: expect.stringMatching(UUID),
      },
    ]);
    expect(await screen.findAllByRole('article')).toHaveLength(2);
  });

  it('retrying the same submission after a failure reuses the idempotency key', async () => {
    server.use(
      http.post('*/v1/admin/claims/:id/review', () => HttpResponse.json({ code: 'x', requestId: 'r', message: 'x' }, { status: 503 }), {
        once: true,
      }),
    );
    const bodies = captureReviews(); // server.use prepends: capture runs before the one-off 503
    open('/review');
    const card = await firstCard();
    decide(card, 'Підтверджую за джерелом');
    expect(await within(card).findByText(/Не вдалося надіслати рішення/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Надіслати рішення' }));

    expect(await screen.findByText('Твердження підтверджено.')).toBeTruthy();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey);
  });

  it('409 keeps the draft, re-reads the record and resubmits against the new version', async () => {
    localStorage.setItem(ADMIN_MOCK_KEY, 'conflict');
    const bodies = captureReviews();
    open('/review');
    const card = await firstCard();
    decide(card, 'Підтверджую за джерелом');

    const banner = await within(card).findByRole('alert');
    expect(banner.textContent).toContain('Запис змінено іншим оператором');
    expect(await within(card).findByText('Поточне твердження (версія 2)')).toBeTruthy();
    expect(document.activeElement).toBe(banner);
    const reason = within(card).getByLabelText<HTMLTextAreaElement>("Причина (обов'язково, потрапляє до аудиту)");
    expect(reason.value).toBe('Підтверджую за джерелом');

    fireEvent.click(within(card).getByRole('button', { name: 'Надіслати рішення' }));
    expect(await screen.findByText('Твердження підтверджено.')).toBeTruthy();
    expect(bodies.map((b) => b.expectedVersion)).toEqual([1, 2]);
    expect(bodies[1]!.idempotencyKey).not.toBe(bodies[0]!.idempotencyKey);
  });

  it('split moves the claim out of its incident against the incident revision', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('*/v1/admin/incidents/:id/split', async ({ request }) => {
        bodies.push(await request.clone().json());
      }),
    );
    open('/review');
    const card = await firstCard();
    fireEvent.click(within(card).getByLabelText('Винести в окрему подію'));
    decide(card, 'Інша група БпЛА');
    expect(await screen.findByText('Твердження винесено в окрему подію.')).toBeTruthy();
    expect(bodies).toEqual([
      { expectedVersion: 2, reason: 'Інша група БпЛА', claimIds: [expect.any(String)], idempotencyKey: expect.stringMatching(UUID) },
    ]);
  });

  it('shows an empty queue as its own state', async () => {
    localStorage.setItem(ADMIN_MOCK_KEY, 'empty');
    open('/review');
    expect(await screen.findByText(/Черга порожня/)).toBeTruthy();
  });
});

describe('ops', () => {
  it('renders queue ages per lane, connector health and unknown cost', async () => {
    open('/ops');
    const queue = within((await screen.findByRole('heading', { name: 'Черга завдань' })).closest('section')!);
    expect(queue.getByText(/1 хв 15 с/).textContent).toContain('відставання');
    expect(queue.getByText('1 год 2 хв')).toBeTruthy();
    expect(queue.getByText('2 — потрібен перегляд')).toBeTruthy();
    expect(screen.getByText('Тиша каналу — конектор працює')).toBeTruthy();
    expect(screen.getByText('Збій конектора')).toBeTruthy();
    expect(screen.getByText('невідомо — тариф не налаштовано')).toBeTruthy();
  });
});

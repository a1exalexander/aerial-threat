import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { routes } from './routes';

it.each(['/', '/history', '/review', '/ops', '/incidents/00000000-0000-4000-8000-000000000001', '/nope'])(
  '%s renders the single Kremenchuk screen at /',
  async (path) => {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Кременчук' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('navigation')).toBeNull();
    await screen.findByRole('region', { name: 'Стан тривоги' }); // let the first fetch settle
  },
);

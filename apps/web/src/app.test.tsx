import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { routes } from './routes';

it('renders the overview route', () => {
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/'] })} />);
  expect(screen.getByRole('heading', { level: 1, name: 'Огляд' })).toBeTruthy();
});

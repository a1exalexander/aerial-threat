import { Link, Outlet, type RouteObject } from 'react-router';
import History from './routes/history';
import Incident from './routes/incident';
import Ops from './routes/ops';
import Overview from './routes/overview';
import Review from './routes/review';

function Layout() {
  return (
    <>
      <header>
        <nav aria-label="Основна навігація">
          <Link to="/">Огляд</Link> <Link to="/history">Історія</Link> <Link to="/review">Перевірка</Link>{' '}
          <Link to="/ops">Операційний стан</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'incidents/:id', element: <Incident /> },
      { path: 'history', element: <History /> },
      { path: 'review', element: <Review /> },
      { path: 'ops', element: <Ops /> },
    ],
  },
];

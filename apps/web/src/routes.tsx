import { Navigate, type RouteObject } from 'react-router';
import SituationScreen from './features/situation/SituationScreen';

/** One screen; any other path (old /history, /review, … links) goes back to it. */
export const routes: RouteObject[] = [
  { index: true, element: <SituationScreen /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

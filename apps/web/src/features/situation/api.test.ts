import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../mocks/node';
import { buildSituation } from '../../mocks/situation/handlers';
import { useSituation } from './api';

function serveWithEtag(etag: string) {
  const seen: (string | null)[] = [];
  server.use(
    http.get('*/v1/situation', ({ request }) => {
      seen.push(request.headers.get('if-none-match'));
      if (request.headers.get('if-none-match') === etag) return new HttpResponse(null, { status: 304 });
      return HttpResponse.json(buildSituation('alert-shahed'), { headers: { etag } });
    }),
  );
  return seen;
}

it('sends the ETag back and does not re-render on 304', async () => {
  const seen = serveWithEtag('"v1"');
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useSituation();
  });
  await waitFor(() => expect(result.current.data).not.toBeNull());
  const first = result.current.data;
  const rendersAfterLoad = renders;

  act(() => document.dispatchEvent(new Event('visibilitychange'))); // visible tab -> immediate poll
  await waitFor(() => expect(seen).toEqual([null, '"v1"']));
  await new Promise((r) => setTimeout(r, 20));

  expect(renders).toBe(rendersAfterLoad);
  expect(result.current.data).toBe(first);
});

it('does a full refresh without If-None-Match when the browser comes back online', async () => {
  const seen = serveWithEtag('"v1"');
  const { result } = renderHook(() => useSituation());
  await waitFor(() => expect(result.current.data).not.toBeNull());

  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(seen).toEqual([null, null]));
});

it('keeps the last good data and reports the error when a refresh fails', async () => {
  serveWithEtag('"v1"');
  const { result } = renderHook(() => useSituation());
  await waitFor(() => expect(result.current.data).not.toBeNull());
  const first = result.current.data;

  server.use(http.get('*/v1/situation', () => HttpResponse.json({ code: 'x', requestId: 'r', message: 'm' }, { status: 503 })));
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.data).toBe(first);
});

import { envelope, Overview } from '@aerial/contracts';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../features/public/api';
import {
  AreaPicker,
  type Areas,
  ErrorPanel,
  OfflineBanner,
  OverviewBody,
  StatusLine,
  useAreas,
} from '../features/public/components';
import { kyivLocalToIso, toKyivLocal } from '../features/public/present';

const OVERVIEW = envelope(Overview);

export default function History() {
  const [params, setParams] = useSearchParams();
  const at = params.get('at');
  const areaId = params.get('area') || 'ua-pl';
  const asOf = at ? kyivLocalToIso(at) : null;
  const areas = useAreas();
  // An archive snapshot never changes, so there is nothing to poll.
  const { data, error, reload } = useApi(
    asOf ? `/v1/overview?areaId=${encodeURIComponent(areaId)}&asOf=${encodeURIComponent(asOf)}` : null,
    OVERVIEW,
    { poll: false },
  );

  return (
    <div className="pub pub--archive">
      <h1>Історія (архів)</h1>
      <p className="pub-banner pub-banner--archive" role="note">
        АРХІВНИЙ РЕЖИМ. Тут показано збережений стан на обраний момент, а не поточну ситуацію. Поточний стан — на
        сторінці <Link to="/">Огляд</Link>.
      </p>
      <OfflineBanner />
      {/* Keyed on the URL so Back/Forward resets the fields to the snapshot actually shown. */}
      <HistoryForm key={params.toString()} at={at} areaId={areaId} areas={areas} onSubmit={setParams} />
      {at && !asOf ? (
        <p className="pub-panel" role="alert">
          Некоректна дата. Оберіть дату й час ще раз.
        </p>
      ) : !asOf ? (
        <p className="pub-panel">Оберіть дату, час і територію, щоб переглянути збережений стан.</p>
      ) : (
        <>
          <StatusLine snapshot={data} error={error} archive />
          {data ? (
            <OverviewBody snapshot={data} areas={areas} archive />
          ) : error ? (
            <ErrorPanel error={error} onRetry={reload} what="архів" />
          ) : null}
        </>
      )}
    </div>
  );
}

type FormProps = {
  at: string | null;
  areaId: string;
  areas: Areas;
  onSubmit: (params: { at: string; area: string }) => void;
};

function HistoryForm({ at, areaId, areas, onSubmit }: FormProps) {
  const [area, setArea] = useState(areaId);
  return (
    <form
      className="pub-toolbar"
      aria-label="Вибір моменту в архіві"
      onSubmit={(e) => {
        e.preventDefault();
        const value = new FormData(e.currentTarget).get('at');
        if (typeof value === 'string') onSubmit({ at: value, area });
      }}
    >
      <div className="pub-field">
        <label htmlFor="history-at">Дата й час (за Києвом)</label>
        <input
          id="history-at"
          name="at"
          type="datetime-local"
          required
          defaultValue={at ?? toKyivLocal(Date.now() - 60 * 60_000)}
          max={toKyivLocal(Date.now())}
        />
      </div>
      <AreaPicker areas={areas} value={area} onChange={setArea} />
      <button type="submit">Показати архів</button>
    </form>
  );
}

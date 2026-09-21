import { envelope, Overview as OverviewDto } from '@aerial/contracts';
import { useSearchParams } from 'react-router';
import { useApi } from '../features/public/api';
import { AreaPicker, ErrorPanel, OfflineBanner, OverviewBody, StatusLine, useAreas } from '../features/public/components';

const OVERVIEW = envelope(OverviewDto);

export default function Overview() {
  const [params, setParams] = useSearchParams();
  const areaId = params.get('area') || 'ua-pl';
  const areas = useAreas();
  const { data, error, reload } = useApi(`/v1/overview?areaId=${encodeURIComponent(areaId)}`, OVERVIEW);

  return (
    <div className="pub">
      <h1>Огляд</h1>
      <OfflineBanner />
      <div className="pub-toolbar">
        <AreaPicker
          areas={areas}
          value={areaId}
          onChange={(id) =>
            setParams((p) => {
              p.set('area', id);
              return p;
            })
          }
        />
        <StatusLine snapshot={data} error={error} />
      </div>
      {data ? (
        <OverviewBody snapshot={data} areas={areas} />
      ) : error ? (
        <ErrorPanel error={error} onRetry={reload} what="огляд" />
      ) : null}
    </div>
  );
}

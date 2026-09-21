import { ReviewQueueResponse } from '@aerial/contracts';
import { useEffect, useRef, useState } from 'react';
import { canReview, useSession } from '../../auth/session';
import { AsOf, ResourceState, useAdminResource } from './resource';
import { ReviewCard } from './ReviewCard';

export function ReviewScreen() {
  const { session } = useSession();
  const [res, reload] = useAdminResource('/v1/admin/review', ReviewQueueResponse);
  const [status, setStatus] = useState<{ text: string } | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // The reviewed card leaves the queue; move focus to the result so keyboard users are not dropped on <body>.
  useEffect(() => {
    if (status) statusRef.current?.focus();
  }, [status]);

  return (
    <section aria-labelledby="review-heading">
      <h1 id="review-heading">Перевірка</h1>
      <p className="hint">
        Твердження, які система не опублікувала автоматично. Підстави показано словами: оцінки моделі відповідають на
        поставлені питання й не є ймовірністю реальної небезпеки.
      </p>
      <p role="status" tabIndex={-1} ref={statusRef} className="status">
        {status?.text}
      </p>
      <ResourceState res={res} retry={reload} need="viewer, reviewer або admin" />
      {res.status === 'ready' && (
        <>
          <AsOf env={res.value} />
          {res.value.nextCursor && (
            <p className="hint">
              Показано перші {res.value.data.length} записів черги; наступні з'являться після їх опрацювання.
            </p>
          )}
          {res.value.data.length === 0 ? (
            <p className="empty">Черга порожня: немає тверджень, що чекають на перевірку.</p>
          ) : (
            <ol className="stack" aria-label="Черга перевірки">
              {res.value.data.map((item) => (
                <li key={item.claim.id}>
                  <ReviewCard
                    item={item}
                    canAct={!!session && canReview(session)}
                    reload={reload}
                    announce={(text) => setStatus({ text })}
                  />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

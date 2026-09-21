import { RequireOperator } from '../auth/RequireOperator';
import '../features/admin/admin.css';
import { ReviewScreen } from '../features/admin/ReviewScreen';

export default function Review() {
  return (
    <RequireOperator title="Перевірка">
      <ReviewScreen />
    </RequireOperator>
  );
}

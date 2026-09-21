import { RequireOperator } from '../auth/RequireOperator';
import '../features/admin/admin.css';
import { OpsScreen } from '../features/admin/OpsScreen';

export default function Ops() {
  return (
    <RequireOperator title="Операційний стан">
      <OpsScreen />
    </RequireOperator>
  );
}

// הגדרות (S17, S18): העסק, סניפים וקופות, עובדים, המכשיר הזה, יומן ביקורת — רק מה שמותר לתפקיד
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Tabs } from '../components/ui';
import { can } from '../lib/session';
import AuditLog from './admin/AuditLog';
import BranchSettings from './admin/BranchSettings';
import BusinessSettings from './admin/BusinessSettings';
import DeviceSettings from './admin/DeviceSettings';
import UserSettings from './admin/UserSettings';
import PilotSettings from './admin/PilotSettings';
import '../styles/admin.css';

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(can('settings:write') ? [{ key: 'business', label: 'העסק', icon: 'building' }, { key: 'pilot', label: 'פיילוט ומסמכים', icon: 'flag' }, { key: 'branches', label: 'סניפים וקופות', icon: 'store' }] : []),
    ...(can('users:write') ? [{ key: 'users', label: 'עובדים', icon: 'users' }] : []),
    { key: 'device', label: 'המכשיר הזה', icon: 'single' },
    ...(can('audit:read') ? [{ key: 'audit', label: 'יומן ביקורת', icon: 'history' }] : []),
  ];
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? tabs[0]!.key;
  return (
    <div className="page-narrow">
      <PageHeader />
      <Tabs items={tabs} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} label="הגדרות" />
      {tab === 'business' && <BusinessSettings />}
      {tab === 'pilot' && <PilotSettings />}
      {tab === 'branches' && <BranchSettings />}
      {tab === 'users' && <UserSettings />}
      {tab === 'device' && <DeviceSettings />}
      {tab === 'audit' && <AuditLog />}
    </div>
  );
}

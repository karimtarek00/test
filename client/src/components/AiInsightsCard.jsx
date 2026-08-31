import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { IconSparkle } from './icons.jsx';

export default function AiInsightsCard() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Must not implicitly return the promise chain -- useEffect treats
  // whatever its callback returns as a cleanup function, and calling a
  // Promise as one crashes with "destroy is not a function" on unmount,
  // taking down the whole app (this is what broke client-side navigation
  // to any other page: DashboardPage renders this card, so its crash on
  // unmount corrupted the entire React tree, not just this component).
  const load = () => { api.get('/ai/insights').then(setData).catch(() => {}); };
  useEffect(load, []);

  if (!data || !data.enabled) return null; // don't clutter the dashboard when AI isn't configured

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await api.post('/ai/insights/refresh', {});
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconSparkle style={{ width: 16, height: 16, color: 'var(--info)' }} />
          AI Insight
        </span>
        {isAdmin && (
          <button className="btn-tertiary" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Generating…' : 'Refresh'}
          </button>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}
      {data.error && !data.text && <div className="error-text">Last attempt failed: {data.error}</div>}
      {data.text ? (
        <>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{data.text}</p>
          {data.at && <div className="text-faint" style={{ fontSize: 11, marginTop: 10 }}>Generated {new Date(data.at).toLocaleString()}</div>}
        </>
      ) : (
        <div className="empty-state" style={{ padding: '16px 0' }}>
          {isAdmin ? 'No insight generated yet — click Refresh.' : 'No insight generated yet.'}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' });
  const [error, setError] = useState('');

  const load = () => api.get('/users').then((data) => setRows(data.users));
  useEffect(() => { load(); }, []);

  const createUser = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/users', form);
      setForm({ username: '', password: '', role: 'viewer' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeUser = async (id) => {
    if (!confirm('Delete this user?')) return;
    await api.del(`/users/${id}`);
    load();
  };

  return (
    <>
      <TopBar title="Users" />
      <div className="content">
        <div className="panel">
          <div className="panel-header"><span className="panel-title">Add User</span></div>
          <form onSubmit={createUser} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Username</label>
              <input className="input" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} required />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Password</label>
              <input type="password" className="input" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Role</label>
              <select className="input" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button className="btn" type="submit">Add</button>
          </form>
          {error && <div className="error-text">{error}</div>}
        </div>

        <div className="panel">
          <table>
            <thead>
              <tr><th>Username</th><th>Role</th><th>Created</th><th>Last Signed In</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td><span className="pill">{u.role}</span></td>
                  <td className="text-dim">{new Date(u.created_at).toLocaleDateString()}</td>
                  <td className="text-dim">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}</td>
                  <td>
                    {u.id !== currentUser.id && (
                      <button className="btn-secondary btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => removeUser(u.id)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

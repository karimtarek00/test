import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { IconChat, IconClose, IconSend } from './icons.jsx';

export default function AiChatWidget() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    api.get('/ai/insights').then((data) => setEnabled(!!data.enabled)).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  if (!enabled) return null; // don't show a widget for a feature that isn't configured

  const send = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setError('');
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setSending(true);
    try {
      const data = await api.post('/ai/chat', { messages: next });
      setMessages([...next, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {open && (
        <div
          className="panel"
          style={{
            position: 'fixed', bottom: 84, right: 24, width: 340, height: 440, display: 'flex', flexDirection: 'column',
            padding: 0, zIndex: 40, boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border-soft)' }}>
            <strong style={{ fontSize: 13.5 }}>Ask AI</strong>
            <button className="modal-close" onClick={() => setOpen(false)}><IconClose /></button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && <div className="text-faint" style={{ fontSize: 12.5 }}>Ask about current alerts, servers, or fleet health — grounded in this app's live data.</div>}
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  background: m.role === 'user' ? 'var(--info)' : 'var(--bg-elevated)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  padding: '8px 12px',
                  borderRadius: 10,
                  fontSize: 13,
                  maxWidth: '85%',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {m.content}
              </div>
            ))}
            {error && <div className="error-text" style={{ fontSize: 12 }}>{error}</div>}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={send} style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border-soft)' }}>
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question…" disabled={sending} />
            <button className="btn" type="submit" disabled={sending || !input.trim()} style={{ padding: '8px 12px' }}>
              <IconSend />
            </button>
          </form>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn"
        style={{
          position: 'fixed', bottom: 24, right: 24, width: 52, height: 52, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40, boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
        }}
        title="Ask AI"
      >
        {open ? <IconClose /> : <IconChat />}
      </button>
    </>
  );
}

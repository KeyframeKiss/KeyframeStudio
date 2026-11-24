import { useEffect, useRef, useState } from 'react';
import { dismissToast, useStore, type Message, type Toast } from '../state/store';
import { Icon } from './Icon';
import { Popover } from './Shell';

/** One popup message: stays up for its reading time, paused while the mouse is on it; × closes it. */
export function ToastItem({ t }: { t: Toast }) {
  const [paused, setPaused] = useState(false);
  const left = useRef(t.ms);
  const startedAt = useRef(0);
  useEffect(() => {
    if (paused) return;
    startedAt.current = performance.now();
    const timer = window.setTimeout(() => dismissToast(t.id), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(800, left.current - (performance.now() - startedAt.current));
    };
  }, [paused, t.id]);
  return (
    <div
      className={`toast ${t.kind}${paused ? ' held' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      style={{ ['--toast-ms' as string]: `${t.ms}ms` }}
    >
      {t.kind === 'done' && (
        <svg className="toast-check" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="7" />
          <path d="M4.6 8.3l2.2 2.2 4.6-4.8" />
        </svg>
      )}
      <span className="toast-text">{t.text}</span>
      <button className="toast-close" onClick={() => dismissToast(t.id)} title="Close (it stays in Messages, in the status bar)" aria-label="Close">
        <Icon name="close" size={11} />
      </button>
      <span className="toast-timer" aria-hidden />
    </div>
  );
}

const when = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** Status bar button: every popup message so far, newest first, to read again at leisure. */
export function MessagesButton() {
  const messages = useStore((s) => s.messages);
  const unread = useStore((s) => s.unreadMessages);
  const errors = useStore((s) => s.messages.slice(0, s.unreadMessages).some((m) => m.kind === 'error'));
  return (
    <Popover
      align="right"
      width={420}
      trigger={(open, toggle) => (
        <button
          className={`sb-messages ${open ? 'on' : ''} ${unread ? 'unread' : ''} ${errors ? 'has-error' : ''}`}
          onClick={() => {
            if (!open) useStore.setState({ unreadMessages: 0 });
            toggle();
          }}
          title="Messages: everything that popped up, to read again"
        >
          <Icon name="bell" size={12} />
          Messages
          {unread > 0 && <span className="sb-count">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    >
      {(close) => <MessageList messages={messages} close={close} />}
    </Popover>
  );
}

function MessageList({ messages, close }: { messages: Message[]; close: () => void }) {
  if (!messages.length) return <div className="msg-empty">No messages yet. What pops up while you work is kept here.</div>;
  return (
    <div className="msg-list">
      <div className="msg-head">
        <b>Messages</b>
        <button
          className="btn small"
          onClick={() => {
            useStore.setState({ messages: [], unreadMessages: 0 });
            close();
          }}
        >
          Clear
        </button>
      </div>
      <div className="msg-scroll">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.kind}`}>
            <span className="msg-dot" aria-hidden />
            <div>
              <div className="msg-text">{m.text}</div>
              <div className="msg-when">{when(m.at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

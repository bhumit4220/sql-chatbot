import React, { useState, useEffect } from 'react';
import type { AuthStatusResponse } from '@chatbot/shared';
import { AGENT_BASE_URL } from '@chatbot/shared';
import { AgentStatus } from './components/AgentStatus.js';
import { UnlockForm } from './components/UnlockForm.js';
import { Settings } from './components/Settings.js';

type View = 'status' | 'unlock' | 'settings';

export function App() {
  const [view, setView] = useState<View>('status');
  const [agentStatus, setAgentStatus] = useState<AuthStatusResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkAgent = async () => {
    try {
      const res = await fetch(`${AGENT_BASE_URL}/auth/status`);
      if (res.ok) {
        const data = await res.json();
        setAgentStatus(data);
        setConnected(true);
        setError(null);

        if (data.configured && data.locked) {
          setView('unlock');
        }
      } else {
        setConnected(false);
        setError('Agent returned error');
      }
    } catch {
      setConnected(false);
      setError('Agent not running. Start it with: pnpm dev:agent');
    }
  };

  useEffect(() => {
    checkAgent();
  }, []);

  const handleUnlocked = (sessionToken: string) => {
    // Notify background worker
    chrome.runtime.sendMessage({
      type: 'AGENT_UNLOCKED',
      payload: {
        sessionToken,
        extensionId: chrome.runtime.id,
      },
    });
    checkAgent();
    setView('status');
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>SQL Chatbot</h1>
        <div style={styles.nav}>
          <button
            style={view === 'status' ? styles.navActive : styles.navBtn}
            onClick={() => setView('status')}
          >
            Status
          </button>
          <button
            style={view === 'settings' ? styles.navActive : styles.navBtn}
            onClick={() => setView('settings')}
          >
            Settings
          </button>
        </div>
      </header>

      <main style={styles.main}>
        {view === 'status' && (
          <AgentStatus
            connected={connected}
            status={agentStatus}
            error={error}
            onRetry={checkAgent}
            onUnlock={() => setView('unlock')}
          />
        )}
        {view === 'unlock' && (
          <UnlockForm onUnlocked={handleUnlocked} onCancel={() => setView('status')} />
        )}
        {view === 'settings' && <Settings />}
      </main>

      <footer style={styles.footer}>
        <span>v2.0.0</span>
        <a
          href="https://github.com/bhumit4220/sql-chatbot"
          target="_blank"
          rel="noopener"
          style={styles.link}
        >
          GitHub
        </a>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: '#f8f9fa',
    color: '#212529',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #dee2e6',
    backgroundColor: '#fff',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
  },
  nav: {
    display: 'flex',
    gap: '8px',
    marginTop: '8px',
  },
  navBtn: {
    padding: '4px 12px',
    border: '1px solid #dee2e6',
    borderRadius: '4px',
    background: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
  },
  navActive: {
    padding: '4px 12px',
    border: '1px solid #0d6efd',
    borderRadius: '4px',
    background: '#e7f1ff',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#0d6efd',
  },
  main: {
    flex: 1,
    padding: '16px',
    overflow: 'auto',
  },
  footer: {
    padding: '8px 16px',
    borderTop: '1px solid #dee2e6',
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
    color: '#6c757d',
  },
  link: {
    color: '#0d6efd',
    textDecoration: 'none',
  },
};

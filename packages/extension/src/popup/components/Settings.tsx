import React, { useState } from 'react';
import { AGENT_BASE_URL } from '@chatbot/shared';

export function Settings() {
  const [clearing, setClearing] = useState(false);

  const handleLock = async () => {
    try {
      await fetch(`${AGENT_BASE_URL}/auth/lock`, { method: 'POST' });
      // Clear session storage
      await chrome.storage.session.clear();
      window.close();
    } catch (err: any) {
      console.error('Lock failed:', err);
    }
  };

  const handleClearHistory = async () => {
    setClearing(true);
    // Clear IndexedDB chat history (will be implemented in Phase 10)
    // For now, just show a placeholder
    setTimeout(() => setClearing(false), 500);
  };

  return (
    <div>
      <h3 style={styles.heading}>Settings</h3>

      <div style={styles.section}>
        <h4 style={styles.subheading}>Security</h4>
        <button style={styles.btnDanger} onClick={handleLock}>
          Lock Vault
        </button>
        <p style={styles.hint}>Locks the vault and clears all session tokens.</p>
      </div>

      <div style={styles.section}>
        <h4 style={styles.subheading}>Data</h4>
        <button style={styles.btn} onClick={handleClearHistory} disabled={clearing}>
          {clearing ? 'Clearing...' : 'Clear Chat History'}
        </button>
      </div>

      <div style={styles.section}>
        <h4 style={styles.subheading}>About</h4>
        <p style={styles.hint}>SQL Chatbot v2.0.0</p>
        <p style={styles.hint}>LLM: OpenAI GPT-4o-mini (via agent proxy)</p>
        <p style={styles.hint}>Agent: http://127.0.0.1:9876</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  heading: { margin: '0 0 16px', fontSize: '14px' },
  section: { marginBottom: '20px' },
  subheading: { margin: '0 0 8px', fontSize: '13px', color: '#495057' },
  hint: { margin: '4px 0', fontSize: '11px', color: '#6c757d' },
  btn: {
    padding: '6px 16px',
    border: '1px solid #dee2e6',
    borderRadius: '4px',
    background: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
  },
  btnDanger: {
    padding: '6px 16px',
    border: 'none',
    borderRadius: '4px',
    background: '#dc3545',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
  },
};

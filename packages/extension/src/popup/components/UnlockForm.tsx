import React, { useState } from 'react';
import { AGENT_BASE_URL } from '@chatbot/shared';

interface Props {
  onUnlocked: (sessionToken: string) => void;
  onCancel: () => void;
}

export function UnlockForm({ onUnlocked, onCancel }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${AGENT_BASE_URL}/auth/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Unlock failed');
      }

      const data = await res.json();
      onUnlocked(data.sessionToken);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <h3 style={styles.heading}>Unlock Vault</h3>
      <p style={styles.hint}>Enter your passphrase to unlock the agent.</p>

      <input
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Passphrase"
        style={styles.input}
        autoFocus
        disabled={loading}
      />

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.actions}>
        <button type="button" style={styles.btn} onClick={onCancel} disabled={loading}>
          Cancel
        </button>
        <button type="submit" style={styles.btnPrimary} disabled={loading || !passphrase.trim()}>
          {loading ? 'Unlocking...' : 'Unlock'}
        </button>
      </div>
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  heading: { margin: '0 0 4px', fontSize: '14px' },
  hint: { margin: '0 0 12px', fontSize: '12px', color: '#6c757d' },
  input: {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #dee2e6',
    borderRadius: '4px',
    fontSize: '13px',
    boxSizing: 'border-box',
  },
  error: { color: '#dc3545', fontSize: '12px', margin: '8px 0' },
  actions: { display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' },
  btn: {
    padding: '6px 16px',
    border: '1px solid #dee2e6',
    borderRadius: '4px',
    background: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
  },
  btnPrimary: {
    padding: '6px 16px',
    border: 'none',
    borderRadius: '4px',
    background: '#0d6efd',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
  },
};

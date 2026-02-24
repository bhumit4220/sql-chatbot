import React from 'react';
import type { AuthStatusResponse } from '@chatbot/shared';

interface Props {
  connected: boolean;
  status: AuthStatusResponse | null;
  error: string | null;
  onRetry: () => void;
  onUnlock: () => void;
}

export function AgentStatus({ connected, status, error, onRetry, onUnlock }: Props) {
  return (
    <div>
      <div style={styles.statusRow}>
        <span
          style={{
            ...styles.dot,
            backgroundColor: connected ? '#198754' : '#dc3545',
          }}
        />
        <span style={styles.label}>
          Agent: {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {status && (
        <div style={styles.details}>
          <p>Version: {status.agentVersion}</p>
          <p>Configured: {status.configured ? 'Yes' : 'No'}</p>
          <p>
            Vault:{' '}
            <span style={{ color: status.locked ? '#dc3545' : '#198754' }}>
              {status.locked ? 'Locked' : 'Unlocked'}
            </span>
          </p>
        </div>
      )}

      <div style={styles.actions}>
        <button style={styles.btn} onClick={onRetry}>
          Refresh
        </button>
        {status?.configured && status?.locked && (
          <button style={styles.btnPrimary} onClick={onUnlock}>
            Unlock Vault
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '12px',
  },
  dot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    display: 'inline-block',
  },
  label: {
    fontWeight: 500,
  },
  error: {
    color: '#dc3545',
    fontSize: '12px',
    margin: '8px 0',
  },
  details: {
    fontSize: '13px',
    lineHeight: 1.6,
  },
  actions: {
    display: 'flex',
    gap: '8px',
    marginTop: '16px',
  },
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

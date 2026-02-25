import React, { useState, useEffect } from 'react';

interface SiteConfig {
  endpoint: string;
  discoveredAt: number;
}

interface SiteEntry {
  origin: string;
  config: SiteConfig;
}

export function App() {
  const [sites, setSites] = useState<SiteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newOrigin, setNewOrigin] = useState('');
  const [newEndpoint, setNewEndpoint] = useState('');

  const loadSites = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SITE_CONFIGS' });
      const entries: SiteEntry[] = Object.entries(response.sites || {}).map(
        ([origin, config]) => ({ origin, config: config as SiteConfig })
      );
      entries.sort((a, b) => b.config.discoveredAt - a.config.discoveredAt);
      setSites(entries);
    } catch (err) {
      console.error('Failed to load sites:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSites(); }, []);

  const removeSite = async (origin: string) => {
    await chrome.runtime.sendMessage({ type: 'REMOVE_SITE', payload: { origin } });
    await loadSites();
  };

  const addSite = async () => {
    if (!newOrigin.trim() || !newEndpoint.trim()) return;
    await chrome.runtime.sendMessage({
      type: 'ADD_SITE_MANUALLY',
      payload: { origin: newOrigin.trim(), endpoint: newEndpoint.trim() },
    });
    setNewOrigin('');
    setNewEndpoint('');
    setShowAddForm(false);
    await loadSites();
  };

  return (
    <div style={{ width: 360, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      <div style={{ padding: '12px 16px', background: '#0d6efd', color: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>SQL Chatbot</span>
        <span style={{ fontSize: 11, opacity: 0.8 }}>v3.0.0</span>
      </div>

      <div style={{ padding: '12px 16px' }}>
        {loading ? (
          <p style={{ color: '#6c757d', textAlign: 'center' }}>Loading...</p>
        ) : sites.length === 0 ? (
          <p style={{ color: '#6c757d', textAlign: 'center', margin: '20px 0' }}>
            No sites detected. Visit a page with the chatbot middleware installed, or add one manually.
          </p>
        ) : (
          <div>
            {sites.map((site) => (
              <div key={site.origin} style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #e9ecef' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#28a745', marginRight: 8, flexShrink: 0 }} />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {site.origin}
                  </div>
                  <div style={{ fontSize: 11, color: '#6c757d' }}>{site.config.endpoint}</div>
                </div>
                <button
                  onClick={() => removeSite(site.origin)}
                  style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', padding: '4px 8px', fontSize: 14 }}
                  title="Remove site"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {showAddForm ? (
          <div style={{ marginTop: 12, padding: 12, background: '#f8f9fa', borderRadius: 8 }}>
            <input
              value={newOrigin}
              onChange={(e) => setNewOrigin(e.target.value)}
              placeholder="Origin (e.g. https://admin.example.com)"
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #dee2e6', borderRadius: 4, marginBottom: 8, fontSize: 12, boxSizing: 'border-box' }}
            />
            <input
              value={newEndpoint}
              onChange={(e) => setNewEndpoint(e.target.value)}
              placeholder="Endpoint (e.g. https://admin.example.com/chatbot)"
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #dee2e6', borderRadius: 4, marginBottom: 8, fontSize: 12, boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addSite} style={{ flex: 1, padding: '6px 12px', background: '#0d6efd', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Add
              </button>
              <button onClick={() => setShowAddForm(false)} style={{ flex: 1, padding: '6px 12px', background: '#e9ecef', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            style={{ marginTop: 12, width: '100%', padding: '8px 12px', background: 'white', border: '1px solid #dee2e6', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: '#495057' }}
          >
            + Add site manually
          </button>
        )}
      </div>
    </div>
  );
}

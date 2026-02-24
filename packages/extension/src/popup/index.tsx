import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>SQL Chatbot</h1>
      <p style={{ color: '#666', fontSize: 14 }}>Connecting to agent...</p>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

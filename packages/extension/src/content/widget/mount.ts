import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWidget } from './ChatWidget.js';

export function mountWidget(): void {
  // Check if already mounted
  if (document.getElementById('sql-chatbot-widget')) return;

  // Create host element
  const host = document.createElement('div');
  host.id = 'sql-chatbot-widget';
  host.style.position = 'fixed';
  host.style.bottom = '20px';
  host.style.right = '20px';
  host.style.zIndex = '2147483647';
  document.body.appendChild(host);

  // Create shadow DOM for style isolation
  const shadow = host.attachShadow({ mode: 'closed' });

  // Add styles
  const style = document.createElement('style');
  style.textContent = getWidgetStyles();
  shadow.appendChild(style);

  // Mount React
  const container = document.createElement('div');
  container.id = 'chatbot-root';
  shadow.appendChild(container);

  const root = createRoot(container);
  root.render(React.createElement(ChatWidget));
}

function getWidgetStyles(): string {
  return `
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }

    .chatbot-fab {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #0d6efd;
      color: white;
      border: none;
      cursor: pointer;
      font-size: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .chatbot-fab:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 16px rgba(0,0,0,0.2);
    }

    .chatbot-panel {
      width: 380px;
      height: 520px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .chatbot-header {
      padding: 12px 16px;
      background: #0d6efd;
      color: white;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
      font-weight: 600;
    }

    .chatbot-close {
      background: none;
      border: none;
      color: white;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
    }

    .chatbot-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 16px;
    }

    .chatbot-message {
      margin-bottom: 12px;
      max-width: 85%;
    }

    .chatbot-message.user {
      margin-left: auto;
      text-align: right;
    }

    .chatbot-message .bubble {
      display: inline-block;
      padding: 8px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.4;
    }

    .chatbot-message.user .bubble {
      background: #0d6efd;
      color: white;
      border-bottom-right-radius: 4px;
    }

    .chatbot-message.assistant .bubble {
      background: #f1f3f5;
      color: #212529;
      border-bottom-left-radius: 4px;
    }

    .chatbot-input-area {
      padding: 12px 16px;
      border-top: 1px solid #e9ecef;
      display: flex;
      gap: 8px;
    }

    .chatbot-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid #dee2e6;
      border-radius: 8px;
      font-size: 13px;
      outline: none;
    }
    .chatbot-input:focus {
      border-color: #0d6efd;
    }

    .chatbot-send {
      padding: 8px 16px;
      background: #0d6efd;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
    }
    .chatbot-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .chatbot-typing {
      display: inline-block;
      padding: 8px 12px;
      background: #f1f3f5;
      border-radius: 12px;
      font-size: 13px;
      color: #6c757d;
    }
  `;
}

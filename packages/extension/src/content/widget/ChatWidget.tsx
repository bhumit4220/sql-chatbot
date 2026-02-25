import React, { useState, useRef, useEffect } from 'react';
import { extractPageData } from '../crawler/extractor.js';
import { discoverMiddleware } from '../discovery/index.js';
import { askQuestion } from '../api/client.js';
import type { StreamCallbacks } from '../api/client.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

type DiscoveryStatus = 'discovering' | 'ready' | 'unavailable' | 'auth-required';

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>('discovering');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const origin = window.location.origin;
  const conversationId = `${origin}-default`;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Run discovery on mount
  useEffect(() => {
    let cancelled = false;

    async function runDiscovery() {
      setDiscoveryStatus('discovering');
      try {
        const result = await discoverMiddleware(origin);
        if (cancelled) return;
        if (result) {
          setEndpoint(result.endpoint);
          setDiscoveryStatus('ready');
        } else {
          setDiscoveryStatus('unavailable');
        }
      } catch {
        if (!cancelled) {
          setDiscoveryStatus('unavailable');
        }
      }
    }

    runDiscovery();
    return () => { cancelled = true; };
  }, [origin]);

  const sendMessage = async () => {
    if (!input.trim() || streaming || !endpoint) return;

    const question = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: question }]);
    setStreaming(true);

    // Crawl the live page for navigation, forms, buttons, breadcrumbs
    const crawled = extractPageData();

    // Extract breadcrumbs from common patterns
    const breadcrumbs: string[] = [];
    document.querySelectorAll('.breadcrumb a, .breadcrumbs a, [aria-label="breadcrumb"] a, nav ol a').forEach(el => {
      const text = el.textContent?.trim();
      if (text) breadcrumbs.push(text);
    });

    const pageContext = {
      url: crawled.url,
      title: crawled.title,
      heading: document.querySelector('h1')?.textContent?.trim() || undefined,
      navigation: crawled.navigation,
      breadcrumbs,
    };

    const callbacks: StreamCallbacks = {
      onToken: (token: string) => {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant') {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + token },
            ];
          }
          return [...prev, { role: 'assistant', content: token }];
        });
      },
      onDone: () => {
        setStreaming(false);
      },
      onError: (error: string) => {
        setStreaming(false);

        // Detect auth errors
        if (error.startsWith('401')) {
          setDiscoveryStatus('auth-required');
        }

        setMessages(prev => [
          ...prev,
          { role: 'assistant', content: `Error: ${error}` },
        ]);
      },
    };

    await askQuestion(
      endpoint,
      {
        question,
        history: messages.map(m => ({ role: m.role, content: m.content })),
        pageContext: JSON.stringify(pageContext),
      },
      callbacks
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!open) {
    return (
      <button className="chatbot-fab" onClick={() => setOpen(true)} title="Ask a question">
        ?
      </button>
    );
  }

  return (
    <div className="chatbot-panel">
      <div className="chatbot-header">
        <span>SQL Chatbot</span>
        <button className="chatbot-close" onClick={() => setOpen(false)}>
          x
        </button>
      </div>

      <div className="chatbot-messages">
        {discoveryStatus === 'discovering' && (
          <p style={{ color: '#6c757d', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>
            Discovering chatbot service...
          </p>
        )}
        {discoveryStatus === 'unavailable' && (
          <p style={{ color: '#dc3545', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>
            No chatbot service found on this site.
          </p>
        )}
        {discoveryStatus === 'auth-required' && messages.length === 0 && (
          <p style={{ color: '#fd7e14', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>
            Please log in to use the chatbot.
          </p>
        )}
        {discoveryStatus === 'ready' && messages.length === 0 && (
          <p style={{ color: '#6c757d', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>
            Ask me about your data, code, or admin panel.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chatbot-message ${msg.role}`}>
            <div className="bubble">{msg.content}</div>
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="chatbot-message assistant">
            <div className="chatbot-typing">Thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chatbot-input-area">
        <input
          className="chatbot-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            discoveryStatus === 'discovering' ? 'Discovering...' :
            discoveryStatus === 'unavailable' ? 'No chatbot available' :
            discoveryStatus === 'auth-required' ? 'Please log in first' :
            'Ask a question...'
          }
          disabled={streaming || discoveryStatus !== 'ready'}
        />
        <button
          className="chatbot-send"
          onClick={sendMessage}
          disabled={streaming || !input.trim() || discoveryStatus !== 'ready'}
        >
          Send
        </button>
      </div>
    </div>
  );
}

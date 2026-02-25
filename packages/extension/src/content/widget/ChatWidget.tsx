import React, { useState, useRef, useEffect } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Listen for streaming responses from background
  useEffect(() => {
    const handler = (message: any) => {
      if (message.type === 'CHAT_RESPONSE_CHUNK') {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant') {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + message.payload.token },
            ];
          }
          return [...prev, { role: 'assistant', content: message.payload.token }];
        });
      } else if (message.type === 'CHAT_RESPONSE_DONE') {
        setStreaming(false);
      } else if (message.type === 'CHAT_ERROR') {
        setStreaming(false);
        setMessages(prev => [
          ...prev,
          { role: 'assistant', content: `Error: ${message.payload.error}` },
        ]);
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const sendMessage = () => {
    if (!input.trim() || streaming) return;

    const question = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: question }]);
    setStreaming(true);

    // Get page context
    const pageContext = {
      url: window.location.href,
      title: document.title,
      heading: document.querySelector('h1')?.textContent || undefined,
      navigation: [],
      breadcrumbs: [],
    };

    // Send to background worker with conversation history
    chrome.runtime.sendMessage({
      type: 'CHAT_QUESTION',
      payload: {
        question,
        conversationId: 'default',
        pageContext,
        history: messages,
      },
    });
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
        {messages.length === 0 && (
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
          placeholder="Ask a question..."
          disabled={streaming}
        />
        <button className="chatbot-send" onClick={sendMessage} disabled={streaming || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from 'react'

interface Props {
  apiKey: string
  apiUrl: string
  position: string
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  sql?: string
}

interface NavItem {
  text: string
  href: string
}

interface PageContext {
  url: string
  title: string
  heading: string | null
  breadcrumbs: NavItem[]
  navigation: NavItem[]
}

function extractNavigation(): NavItem[] {
  const navSelectors = [
    'nav a',
    '[class*="sidebar"] a',
    '[class*="menu"] a',
    '[class*="nav"] a',
    '[role="navigation"] a',
  ]

  const links = new Set<string>()
  const items: NavItem[] = []

  for (const selector of navSelectors) {
    document.querySelectorAll(selector).forEach(el => {
      const a = el as HTMLAnchorElement
      const href = a.getAttribute('href')
      const text = a.textContent?.trim()
      if (href && text && !links.has(href) && href !== '#') {
        links.add(href)
        // Detect parent-child hierarchy (M1)
        const parentLi = a.closest('ul')?.closest('li')
        const parentText = parentLi?.querySelector(':scope > a')?.textContent?.trim()
        items.push({
          text: parentText && parentText !== text ? `${parentText} → ${text}` : text,
          href,
        })
      }
    })
  }

  return items.slice(0, 80) // cap at 80 items
}

function getPageContext(): PageContext {
  return {
    url: window.location.href,
    title: document.title,
    heading: document.querySelector('h1, h2')?.textContent?.trim() || null,
    breadcrumbs: Array.from(
      document.querySelectorAll('[class*="breadcrumb"] a, nav[aria-label="breadcrumb"] a')
    ).map(a => ({
      text: a.textContent?.trim() || '',
      href: a.getAttribute('href') || '',
    })),
    navigation: extractNavigation(),
  }
}

export function ChatWidget({ apiKey, apiUrl, position }: Props) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const sessionId = useRef(
    localStorage.getItem('sql-chatbot-session') ||
    (() => {
      const id = crypto.randomUUID()
      localStorage.setItem('sql-chatbot-session', id)
      return id
    })()
  )

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(scrollToBottom, [messages])

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: question }])
    setLoading(true)

    try {
      const pageContext = getPageContext()

      // Get CSRF token for same-origin Rails requests
      const csrfMeta = document.querySelector('meta[name="csrf-token"]')
      const csrfToken = csrfMeta?.getAttribute('content') || ''

      // Build history from previous messages
      const history = messages.map(m => ({
        role: m.role,
        content: m.content,
      }))

      const resp = await fetch(`${apiUrl}/chatbot/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'X-CSRF-Token': csrfToken,
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          question,
          history,
          pageContext: pageContext,
        }),
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`)
      }

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ''
      let currentSql = ''

      setMessages(prev => [...prev, { role: 'assistant', content: '' }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        let currentEvent = 'message'
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const rawData = line.slice(6)
            if (rawData === '[DONE]') break
            try {
              const data = JSON.parse(rawData)
              switch (currentEvent) {
                case 'message':
                  if (data.token) {
                    assistantMsg += data.token
                    setMessages(prev => {
                      const updated = [...prev]
                      updated[updated.length - 1] = {
                        role: 'assistant',
                        content: assistantMsg,
                        sql: currentSql || undefined,
                      }
                      return updated
                    })
                  } else if (data.error) {
                    // Handle inline error (no event: prefix from Rails)
                    assistantMsg = data.error
                    setMessages(prev => {
                      const updated = [...prev]
                      updated[updated.length - 1] = {
                        role: 'assistant',
                        content: assistantMsg,
                      }
                      return updated
                    })
                  }
                  break
                case 'sql_generated':
                  if (data.sql) {
                    currentSql = data.sql
                  }
                  break
                case 'info':
                  // Could show an info indicator, for now append as text
                  if (data.message) {
                    assistantMsg += `_${data.message}_\n`
                    setMessages(prev => {
                      const updated = [...prev]
                      updated[updated.length - 1] = {
                        role: 'assistant',
                        content: assistantMsg,
                      }
                      return updated
                    })
                  }
                  break
                case 'exploration':
                  // Optional: show "Exploring data..." indicator
                  break
                case 'error':
                  if (data.message) {
                    assistantMsg = data.message
                    setMessages(prev => {
                      const updated = [...prev]
                      updated[updated.length - 1] = {
                        role: 'assistant',
                        content: assistantMsg,
                      }
                      return updated
                    })
                  }
                  break
                case 'done':
                  // End of stream — nothing to do
                  break
              }
            } catch { /* ignore parse errors for non-JSON lines */ }
            currentEvent = 'message' // reset after data
          }
        }
      }
    } catch {
      setMessages(prev => [
        ...prev.slice(0, -1),
        { role: 'assistant', content: 'Something went wrong. Please try again.' },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`chatbot-container ${position}`}>
      {open && (
        <div className="chatbot-panel">
          <div className="chatbot-header">
            <span>AI Assistant</span>
            <button onClick={() => setOpen(false)}>&times;</button>
          </div>
          <div className="chatbot-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`chatbot-msg ${msg.role}`}>
                {msg.content || (loading && i === messages.length - 1 ? '...' : '')}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div className="chatbot-input">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage()}
              placeholder="Ask a question..."
              disabled={loading}
            />
            <button onClick={sendMessage} disabled={loading}>Send</button>
          </div>
        </div>
      )}
      <button className="chatbot-fab" onClick={() => setOpen(!open)}>
        {open ? '\u2715' : '\uD83D\uDCAC'}
      </button>
    </div>
  )
}

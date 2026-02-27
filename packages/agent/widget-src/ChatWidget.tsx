import { useState, useRef, useEffect } from 'react'

interface Props {
  baseUrl: string
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
        // Detect parent-child hierarchy
        const parentLi = a.closest('ul')?.closest('li')
        const parentText = parentLi?.querySelector(':scope > a')?.textContent?.trim()
        items.push({
          text: parentText && parentText !== text ? `${parentText} > ${text}` : text,
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

export function ChatWidget({ baseUrl, position }: Props) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(scrollToBottom, [messages])

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')

    const userMessage: Message = { role: 'user', content: question }
    setMessages(prev => [...prev, userMessage])
    setLoading(true)

    try {
      const pageContext = getPageContext()

      // Build history from current messages + the new user message
      const history = [...messages, userMessage].map(m => ({
        role: m.role,
        content: m.content,
      }))

      const resp = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question,
          pageContext: JSON.stringify(pageContext),
          history,
        }),
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`)
      }

      if (!resp.body) {
        throw new Error('No response body')
      }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ''
      let currentSql = ''

      setMessages(prev => [...prev, { role: 'assistant', content: '' }])

      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            switch (data.type) {
              case 'token':
                if (data.content) {
                  assistantMsg += data.content
                  setMessages(prev => {
                    const updated = [...prev]
                    updated[updated.length - 1] = {
                      role: 'assistant',
                      content: assistantMsg,
                      sql: currentSql || undefined,
                    }
                    return updated
                  })
                }
                break
              case 'sql':
                if (data.sql) {
                  currentSql = data.sql
                }
                break
              case 'classifying':
              case 'classified':
              case 'executing':
                // Status events — could show indicators in future
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
                // End of stream
                break
            }
          } catch { /* ignore parse errors for non-JSON lines */ }
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

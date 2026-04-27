import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { ChatWidget } from './ChatWidget'
import styles from './styles.css?inline'

;(function () {
  // Fallback chain for async/defer script loading
  const script = document.currentScript
    || document.querySelector('script[data-chatbot-id]')
    || document.querySelector('script[src*="widget.js"]')

  if (!script) {
    console.error('[Chatbot] Could not find widget script element.')
    return
  }

  // Auto-detect base URL from the script src attribute
  // e.g. "http://localhost:4000/chatbot/widget.js" → "http://localhost:4000/chatbot"
  const src = (script as HTMLScriptElement).src || ''
  const baseUrl = src.replace(/\/widget\.js(\?.*)?$/, '') || ''

  const position = script.getAttribute('data-position') || 'bottom-right'

  // Manifest URL is opt-in. If the host app ships a build-time chatbot manifest
  // (route map, code index for SPA route detection), set
  // `data-manifest-url="/chatbot-manifest.json"` on the script tag.
  // Default is empty → widget skips the manifest fetch entirely so apps without
  // a manifest don't see noisy 404s in the browser console.
  const manifestUrl = script.getAttribute('data-manifest-url') || ''

  // Create Shadow DOM host
  const host = document.createElement('div')
  host.id = 'sql-chatbot-host'
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'closed' })

  // Inject styles into Shadow DOM
  const styleEl = document.createElement('style')
  styleEl.textContent = styles
  shadow.appendChild(styleEl)

  // Mount React into Shadow DOM
  const container = document.createElement('div')
  shadow.appendChild(container)

  const root = createRoot(container)
  root.render(createElement(ChatWidget, { baseUrl, position, manifestUrl }))
})()

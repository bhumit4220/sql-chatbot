import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { ChatWidget } from './ChatWidget'
import styles from './styles.css?inline'

;(function () {
  const script = document.currentScript as HTMLScriptElement
  const apiKey = script?.getAttribute('data-api-key') || ''
  const apiUrl = script?.getAttribute('data-api-url') || ''
  const position = script?.getAttribute('data-position') || 'bottom-right'

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
  root.render(createElement(ChatWidget, { apiKey, apiUrl, position }))
})()

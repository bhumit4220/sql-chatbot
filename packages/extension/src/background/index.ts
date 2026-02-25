/**
 * SQL Chatbot V3 — Background Worker (Simplified)
 *
 * In V3 the content script makes HTTP calls directly to the middleware.
 * The background worker only handles:
 *   1. Extension lifecycle events (install / update)
 *   2. Site-config management messages from the popup
 */

import { handleMessage } from './message-handler.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('SQL Chatbot extension installed');
  } else if (details.reason === 'update') {
    console.log('SQL Chatbot extension updated');
  }
});

// ---------------------------------------------------------------------------
// Message handler for popup communication
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      sendResponse({ error: err.message });
    });
  return true; // keep channel open for async response
});

console.log('SQL Chatbot V3 background worker initialized');

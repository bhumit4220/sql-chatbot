import { setupMessageRouter, setAgentClient } from './message-router.js';
import { AgentClient } from './agent-client.js';
import { AGENT_BASE_URL } from '@chatbot/shared';

// Initialize message router
setupMessageRouter();

// Restore session on service worker startup
chrome.storage.session.get(['sessionToken', 'extensionId'], (result: Record<string, string>) => {
  if (result.sessionToken && result.extensionId) {
    const client = new AgentClient({
      sessionToken: result.sessionToken,
      extensionId: result.extensionId,
    });
    setAgentClient(client);
    console.log('Agent client restored from session storage');
  }
});

// Listen for unlock events from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AGENT_UNLOCKED') {
    const { sessionToken, extensionId } = message.payload;
    const client = new AgentClient({ sessionToken, extensionId });
    setAgentClient(client);
    chrome.storage.session.set({ sessionToken, extensionId });
    sendResponse({ connected: true });
  }
  return false; // Don't keep channel open for this one
});

console.log('SQL Chatbot background worker initialized');

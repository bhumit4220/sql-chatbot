import type { ExtensionMessage } from '@chatbot/shared';
import { AgentClient } from './agent-client.js';

let agentClient: AgentClient | null = null;

export function setAgentClient(client: AgentClient): void {
  agentClient = client;
}

export function getAgentClient(): AgentClient | null {
  return agentClient;
}

/**
 * Routes messages from content scripts to the agent and back.
 * All agent HTTP calls go through the background worker.
 */
export function setupMessageRouter(): void {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // Keep channel open for async response
  });
}

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case 'AGENT_STATUS': {
      try {
        const status = await agentClient?.get('/auth/status');
        return { connected: true, ...status };
      } catch {
        return { connected: false };
      }
    }

    case 'CHAT_QUESTION': {
      if (!agentClient) throw new Error('Not connected to agent');
      const payload = message.payload as any;

      // Relay to the content script tab via streaming
      const tabId = sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');

      // Start streaming in background
      agentClient.streamSSE('/llm/answer', payload, (token) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'CHAT_RESPONSE_CHUNK',
          payload: { token },
        });
      }).then(() => {
        chrome.tabs.sendMessage(tabId, {
          type: 'CHAT_RESPONSE_DONE',
          payload: {},
        });
      }).catch((err) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'CHAT_ERROR',
          payload: { error: err.message },
        });
      });

      return { streaming: true };
    }

    case 'PAGE_CONTEXT': {
      // Store page context from content script
      return { received: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

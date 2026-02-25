/**
 * Message router unit tests — tests the exported getter/setter and
 * setupMessageRouter registration without needing a real Chrome runtime.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Provide minimal chrome API stubs before importing the module under test.
const addListenerMock = vi.fn();

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: addListenerMock },
  },
  tabs: { sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn() } },
} as any;

import {
  setAgentClient,
  getAgentClient,
  setupMessageRouter,
} from '../message-router.js';
import { AgentClient } from '../agent-client.js';

beforeEach(() => {
  addListenerMock.mockClear();
});

// ---------------------------------------------------------------------------
// AgentClient getter / setter
// ---------------------------------------------------------------------------

describe('agentClient getter/setter', () => {
  it('getAgentClient returns null initially', () => {
    // The module starts with agentClient = null. Because we only import
    // once (no resetModules here — chrome mock would be lost), this test
    // relies on the default state.  If a prior test called setAgentClient,
    // reset it first:
    setAgentClient(null as any);
    // getAgentClient should return whatever was set.
    // With null cast, the internal variable becomes null.
    expect(getAgentClient()).toBeNull();
  });

  it('round-trips: setAgentClient then getAgentClient', () => {
    const client = new AgentClient({
      sessionToken: 'tok-abc',
      extensionId: 'ext-123',
    });
    setAgentClient(client);

    const result = getAgentClient();
    expect(result).toBe(client);
    expect(result).toBeInstanceOf(AgentClient);
  });

  it('overwrites the previous client', () => {
    const first = new AgentClient({ sessionToken: 'a', extensionId: 'e1' });
    const second = new AgentClient({ sessionToken: 'b', extensionId: 'e2' });

    setAgentClient(first);
    expect(getAgentClient()).toBe(first);

    setAgentClient(second);
    expect(getAgentClient()).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// setupMessageRouter
// ---------------------------------------------------------------------------

describe('setupMessageRouter', () => {
  it('registers a chrome.runtime.onMessage listener', () => {
    setupMessageRouter();
    expect(addListenerMock).toHaveBeenCalledTimes(1);
    expect(addListenerMock).toHaveBeenCalledWith(expect.any(Function));
  });

  it('registered listener returns true for async response', () => {
    addListenerMock.mockClear();
    setupMessageRouter();

    const listener = addListenerMock.mock.calls[0][0];
    const sendResponse = vi.fn();

    // Call with AGENT_STATUS message — should return true to keep channel open
    const result = listener(
      { type: 'AGENT_STATUS', payload: {} },
      { tab: { id: 1 } },
      sendResponse,
    );
    expect(result).toBe(true);
  });
});

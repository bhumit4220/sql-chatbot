/**
 * V3 Background Worker — Message handler
 *
 * Pure async function with no side-effects on import.
 * The lifecycle registration lives in index.ts.
 */

export async function handleMessage(
  message: { type: string; payload?: any },
): Promise<unknown> {
  switch (message.type) {
    case 'GET_SITE_CONFIGS': {
      const result = await chrome.storage.local.get(null);
      const sites: Record<string, any> = {};
      for (const [key, value] of Object.entries(result)) {
        if (key.startsWith('site:')) {
          sites[key.replace('site:', '')] = value;
        }
      }
      return { sites };
    }

    case 'REMOVE_SITE': {
      const origin = message.payload?.origin;
      if (origin) {
        await chrome.storage.local.remove(`site:${origin}`);
      }
      return { removed: true };
    }

    case 'ADD_SITE_MANUALLY': {
      const { origin, endpoint } = message.payload ?? {};
      if (origin && endpoint) {
        await chrome.storage.local.set({
          [`site:${origin}`]: { endpoint, discoveredAt: Date.now() },
        });
      }
      return { added: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

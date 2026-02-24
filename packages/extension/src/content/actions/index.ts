import { fillField, selectOption } from './form-filler.js';
import { navigateTo, scrollToElement } from './navigator.js';

export interface ActionRequest {
  action: 'fill' | 'select' | 'click' | 'navigate' | 'scroll';
  selector: string;
  value?: string;
}

export interface ActionResult {
  success: boolean;
  action: string;
  error?: string;
}

/**
 * Safety tiers:
 * - read: Always allowed (scroll, navigate to read pages)
 * - create: Fill + highlight, wait for user confirmation
 * - destructive: Refuse with explanation
 */
export function executeAction(request: ActionRequest): ActionResult {
  try {
    switch (request.action) {
      case 'fill':
        return {
          success: fillField(request.selector, request.value || ''),
          action: 'fill',
        };
      case 'select':
        return {
          success: selectOption(request.selector, request.value || ''),
          action: 'select',
        };
      case 'click': {
        const el = document.querySelector(request.selector) as HTMLElement | null;
        if (el) {
          el.click();
          return { success: true, action: 'click' };
        }
        return { success: false, action: 'click', error: 'Element not found' };
      }
      case 'navigate':
        return {
          success: navigateTo(request.value || request.selector),
          action: 'navigate',
        };
      case 'scroll':
        return {
          success: scrollToElement(request.selector),
          action: 'scroll',
        };
      default:
        return { success: false, action: request.action, error: 'Unknown action' };
    }
  } catch (err: any) {
    return { success: false, action: request.action, error: err.message };
  }
}

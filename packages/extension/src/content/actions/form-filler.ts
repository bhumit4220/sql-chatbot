/**
 * Fills a form field with framework-aware value setting.
 * Uses React's internal fiber to trigger proper change events.
 */
export function fillField(selector: string, value: string): boolean {
  const el = document.querySelector(selector) as HTMLInputElement | null;
  if (!el) return false;

  // React-aware value setting
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }

  // Dispatch events that React and other frameworks listen for
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return true;
}

/**
 * Selects an option in a <select> element.
 */
export function selectOption(selector: string, value: string): boolean {
  const el = document.querySelector(selector) as HTMLSelectElement | null;
  if (!el) return false;

  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

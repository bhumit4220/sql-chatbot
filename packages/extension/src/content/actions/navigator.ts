/**
 * Navigates to a URL or clicks a navigation element.
 */
export function navigateTo(urlOrSelector: string): boolean {
  // If it looks like a URL, navigate directly
  if (urlOrSelector.startsWith('http') || urlOrSelector.startsWith('/')) {
    window.location.href = urlOrSelector;
    return true;
  }

  // Otherwise, try to click the element
  const el = document.querySelector(urlOrSelector) as HTMLElement | null;
  if (el) {
    el.click();
    return true;
  }

  return false;
}

/**
 * Scrolls to an element on the page.
 */
export function scrollToElement(selector: string): boolean {
  const el = document.querySelector(selector);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }
  return false;
}

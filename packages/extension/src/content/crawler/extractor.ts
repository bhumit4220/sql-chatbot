import type { NavItem, FormInfo, FormField, ButtonInfo, TableInfo, CrawledPage } from '@chatbot/shared';

/**
 * Extracts structured data from the current page's DOM.
 */
export function extractPageData(): CrawledPage {
  return {
    url: window.location.href,
    title: document.title,
    navigation: extractNavigation(),
    forms: extractForms(),
    buttons: extractButtons(),
    tables: extractTables(),
    crawledAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  };
}

function extractNavigation(): NavItem[] {
  const items: NavItem[] = [];
  const navElements = document.querySelectorAll('nav a, .sidebar a, .menu a, [role="navigation"] a');

  navElements.forEach(el => {
    const anchor = el as HTMLAnchorElement;
    const text = anchor.textContent?.trim();
    if (text && anchor.href) {
      items.push({
        text,
        href: anchor.href,
        selector: generateSelector(anchor),
      });
    }
  });

  return items.slice(0, 100); // Cap at 100 nav items
}

function extractForms(): FormInfo[] {
  const forms: FormInfo[] = [];

  document.querySelectorAll('form').forEach(form => {
    const fields: FormField[] = [];

    form.querySelectorAll('input, select, textarea').forEach(el => {
      const input = el as HTMLInputElement;
      const label = findLabel(input);

      fields.push({
        label: label || input.name || input.id || 'unlabeled',
        selector: generateSelector(input),
        type: input.type || input.tagName.toLowerCase(),
        options: input.tagName === 'SELECT'
          ? Array.from((input as unknown as HTMLSelectElement).options).map(o => o.text)
          : undefined,
        required: input.required,
      });
    });

    forms.push({
      action: form.action || undefined,
      fields,
    });
  });

  return forms;
}

function extractButtons(): ButtonInfo[] {
  const buttons: ButtonInfo[] = [];

  document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(el => {
    const text = el.textContent?.trim() || (el as HTMLInputElement).value || '';
    if (!text) return;

    const actionType = classifyButton(text);
    buttons.push({
      text,
      selector: generateSelector(el),
      actionType,
    });
  });

  return buttons.slice(0, 50);
}

function extractTables(): TableInfo[] {
  const tables: TableInfo[] = [];

  document.querySelectorAll('table').forEach(table => {
    const headers: string[] = [];
    table.querySelectorAll('th').forEach(th => {
      const text = th.textContent?.trim();
      if (text) headers.push(text);
    });

    if (headers.length > 0) {
      tables.push({
        headers,
        selector: generateSelector(table),
      });
    }
  });

  return tables;
}

function classifyButton(text: string): 'read' | 'create' | 'destructive' | 'unknown' {
  const lower = text.toLowerCase();
  if (/delete|remove|destroy|cancel/i.test(lower)) return 'destructive';
  if (/create|add|new|save|submit/i.test(lower)) return 'create';
  if (/view|show|search|filter|export|download/i.test(lower)) return 'read';
  return 'unknown';
}

function generateSelector(el: Element): string {
  if (el.id) return `#${el.id}`;

  const parts: string[] = [];
  let current: Element | null = el;

  for (let i = 0; i < 3 && current; i++) {
    let selector = current.tagName.toLowerCase();
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).slice(0, 2);
      if (classes.length > 0 && classes[0]) {
        selector += '.' + classes.join('.');
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function findLabel(input: HTMLElement): string | null {
  // Check for associated label
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label.textContent?.trim() || null;
  }

  // Check for wrapping label
  const parentLabel = input.closest('label');
  if (parentLabel) return parentLabel.textContent?.trim() || null;

  // Check aria-label
  return input.getAttribute('aria-label') || null;
}

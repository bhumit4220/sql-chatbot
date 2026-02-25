import type { NavItem, FormInfo, FormField, ButtonInfo, TableInfo, CrawledPage } from '@chatbot/shared';

/**
 * Extracts structured data from the current page's DOM.
 * Framework-agnostic — works with any HTML structure.
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

/**
 * Auto-detects navigation links from any page structure.
 *
 * Strategy (layered, most specific to broadest):
 * 1. Semantic: <nav>, [role="navigation"], aria-label containing "nav/menu"
 * 2. Common class/id patterns: sidebar, menu, nav, drawer, topbar, header links
 * 3. Structural: find the largest cluster of internal <a> links in a single container
 *
 * This approach works with Rails, React, Angular, Vue, Django, WordPress, custom HTML.
 */
function extractNavigation(): NavItem[] {
  const seen = new Set<string>();
  const items: NavItem[] = [];

  function addLink(anchor: HTMLAnchorElement): void {
    const text = anchor.textContent?.trim();
    if (!text || text.length > 60) return; // Skip empty or overly long text
    if (!anchor.href || anchor.href === '#' || anchor.href.startsWith('javascript:')) return;
    // Only internal links (same origin) — skip external
    try {
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin) return;
    } catch {
      return;
    }
    // Deduplicate by href
    if (seen.has(anchor.href)) return;
    seen.add(anchor.href);

    items.push({
      text,
      href: anchor.href,
      selector: generateSelector(anchor),
    });
  }

  // Layer 1: Semantic HTML (highest confidence)
  const semanticSelectors = [
    'nav a',
    '[role="navigation"] a',
    '[aria-label*="nav" i] a',
    '[aria-label*="menu" i] a',
    '[aria-label*="sidebar" i] a',
  ];
  for (const sel of semanticSelectors) {
    document.querySelectorAll(sel).forEach(el => addLink(el as HTMLAnchorElement));
  }

  // Layer 2: Common class/id patterns (covers most frameworks)
  const classPatterns = [
    'sidebar', 'side-bar', 'side_bar', 'sidenav', 'side-nav',
    'menu', 'nav-menu', 'main-menu', 'navigation',
    'drawer', 'app-drawer',
    'topbar', 'top-bar', 'navbar', 'nav-bar',
    'header-nav', 'header-links',
    'left-panel', 'left-menu', 'aside',
  ];

  for (const pattern of classPatterns) {
    // Match class or id containing the pattern
    const selectors = [
      `[class*="${pattern}" i] a`,
      `[id*="${pattern}" i] a`,
    ];
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => addLink(el as HTMLAnchorElement));
      } catch {
        // Some selectors may be invalid in older browsers
      }
    }
  }

  // Layer 3: <aside> elements (semantic sidebar)
  document.querySelectorAll('aside a').forEach(el => addLink(el as HTMLAnchorElement));

  // Layer 4: Structural detection — find the container with the most internal links
  // This catches custom navigation that doesn't use standard classes
  if (items.length < 3) {
    const linkClusters = findLinkClusters();
    for (const anchor of linkClusters) {
      addLink(anchor);
    }
  }

  return items.slice(0, 150); // Cap at 150 nav items
}

/**
 * Finds the largest cluster of internal links within a single container.
 * Used as a fallback when semantic/class detection finds too few links.
 */
function findLinkClusters(): HTMLAnchorElement[] {
  const origin = window.location.origin;
  const containerMap = new Map<Element, HTMLAnchorElement[]>();

  // Look at all anchors and group by their nearest block-level parent
  document.querySelectorAll('a[href]').forEach(el => {
    const anchor = el as HTMLAnchorElement;
    try {
      if (new URL(anchor.href).origin !== origin) return;
    } catch { return; }

    const text = anchor.textContent?.trim();
    if (!text || text.length > 60) return;

    // Walk up to find a meaningful container (ul, div, section, aside, header)
    let container = anchor.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      const tag = container.tagName.toLowerCase();
      if (['ul', 'ol', 'div', 'section', 'aside', 'header', 'footer'].includes(tag)) {
        break;
      }
      container = container.parentElement;
    }

    if (container) {
      if (!containerMap.has(container)) containerMap.set(container, []);
      containerMap.get(container)!.push(anchor);
    }
  });

  // Find the container with the most links (likely the navigation)
  let bestContainer: HTMLAnchorElement[] = [];
  for (const [, anchors] of containerMap) {
    if (anchors.length > bestContainer.length && anchors.length >= 3) {
      bestContainer = anchors;
    }
  }

  return bestContainer;
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

import { extractPageData } from './extractor.js';
import type { CrawledPage } from '@chatbot/shared';

/**
 * Crawls the current page and optionally follows links.
 */
export async function crawlCurrentPage(): Promise<CrawledPage> {
  return extractPageData();
}

/**
 * SPA-aware: detect if a page uses client-side routing.
 * Checks for common SPA framework markers.
 */
export function isSPA(): boolean {
  return !!(
    document.querySelector('[data-reactroot]') ||
    document.querySelector('#__next') ||
    document.querySelector('#app[data-v-app]') ||
    document.querySelector('ember-application') ||
    document.querySelector('[ng-app]') ||
    document.querySelector('[data-turbo]') ||
    document.querySelector('[data-turbolinks]')
  );
}

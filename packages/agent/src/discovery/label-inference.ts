import type { EnumCandidate } from './data-sampler.js';
import type { EnumMapping } from '@chatbot/shared';
import { searchCode } from '../git/search.js';

/**
 * Infers enum labels from code search results.
 * Supports multiple enum definition patterns:
 *   - Ruby/Rails: enum status: { 'Active': 1, 'Inactive': 2 }
 *   - Python:     STATUS_ACTIVE = 1
 *   - JS/TS:      Active = 1, or { Active: 1 }
 */
export function inferEnumLabelsFromCode(
  candidates: EnumCandidate[]
): EnumMapping[] {
  const results: EnumMapping[] = [];

  for (const candidate of candidates) {
    // Search for the column name in code (e.g., "status" enum definitions)
    let codeResults: { content: string; score: number }[] = [];
    try {
      codeResults = searchCode(`enum ${candidate.column}`, 10);
    } catch {
      // Code index may not exist yet — skip code search
    }

    // Also try searching for the column name with common enum patterns
    if (codeResults.length === 0) {
      try {
        codeResults = searchCode(`${candidate.column} enum ${candidate.table}`, 5);
      } catch {
        // Ignore
      }
    }

    const mappings: Record<string, string> = {};
    let foundInCode = false;

    for (const chunk of codeResults) {
      const content = chunk.content;

      // Pattern 1: Ruby/Rails hash enum — 'Label': value or "Label": value
      // Matches: 'Active': 1, "Inactive": 2
      const rubyEnumPattern = /['"](\w[\w\s]*?)['"]:\s*(\d+)/g;
      for (const match of content.matchAll(rubyEnumPattern)) {
        const label = match[1];
        const value = match[2];
        if (candidate.distinctValues.includes(Number(value))) {
          mappings[value] = label;
          foundInCode = true;
        }
      }

      // Pattern 2: JS/TS/Python — Label = value or Label: value (without quotes)
      // Matches: Active = 1, Active: 1
      if (!foundInCode) {
        const jsEnumPattern = /(\w+)\s*[:=]\s*(\d+)/g;
        for (const match of content.matchAll(jsEnumPattern)) {
          const label = match[1];
          const value = match[2];
          // Skip generic words that aren't labels
          if (/^(enum|type|const|let|var|def|class|module|id|pk)$/i.test(label)) continue;
          if (candidate.distinctValues.includes(Number(value))) {
            mappings[value] = label.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            foundInCode = true;
          }
        }
      }
    }

    // Fallback: label values numerically
    if (!foundInCode) {
      for (const val of candidate.distinctValues) {
        mappings[String(val)] = `${candidate.column}_${val}`;
      }
    }

    results.push({
      table: candidate.table,
      column: candidate.column,
      mappings,
      description: foundInCode
        ? `Labels from code for ${candidate.table}.${candidate.column}`
        : `Auto-detected in ${candidate.table}.${candidate.column} (labels pending)`,
    });
  }

  return results;
}

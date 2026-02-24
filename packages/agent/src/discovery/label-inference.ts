import type { EnumCandidate } from './data-sampler.js';
import type { EnumMapping } from '@chatbot/shared';
import { searchCode } from '../git/search.js';

/**
 * Infers enum labels from code search results.
 * Searches code index for enum definitions matching the table.column pattern.
 */
export function inferEnumLabelsFromCode(
  candidates: EnumCandidate[]
): EnumMapping[] {
  const results: EnumMapping[] = [];

  for (const candidate of candidates) {
    // Search for the column name in code (e.g., "status" enum definitions)
    let codeResults: { content: string; score: number }[] = [];
    try {
      codeResults = searchCode(`${candidate.column} enum ${candidate.table}`, 5);
    } catch {
      // Code index may not exist yet — skip code search
    }

    const mappings: Record<string, string> = {};

    // Try to extract mappings from code
    let foundInCode = false;
    for (const chunk of codeResults) {
      // Look for patterns like: status: { Active: 1, Inactive: 2 }
      // or enum(:status, active: 1, inactive: 2)
      const enumPattern = new RegExp(
        `(\\w+)\\s*[:=]\\s*${candidate.distinctValues.map(v => `(${v})`).join('|')}`,
        'gi'
      );
      const matches = chunk.content.matchAll(enumPattern);
      for (const match of matches) {
        if (match[1] && match[2]) {
          mappings[match[2]] = match[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          foundInCode = true;
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

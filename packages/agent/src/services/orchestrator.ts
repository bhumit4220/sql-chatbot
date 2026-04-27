import { callLLM, streamLLM } from '../llm/client.js';
import { buildClassifyMessages } from '../prompts/classify.js';
import { buildGenerateSqlMessages } from '../prompts/generate-sql.js';
import { buildAnswerMessages } from '../prompts/answer.js';
import { validateSql, executeSql } from './sql-executor.js';
import type { SchemaService } from './schema.js';
import type { CodeIndexer, SearchResult } from './code-indexer.js';
import type { ChatMessage } from '../prompts/classify.js';
import type { QuestionType } from '../prompts/answer.js';
import type { CodeSnippet } from '../prompts/answer.js';
import { tryGrammarPath } from '../grammar/try-grammar-path.js';
import { checkCountSanity } from '../grammar/sanity-check.js';
import { logMiss } from '../grammar/miss-logger.js';
import type { Registry } from '../grammar/registry.js';

// ============================================================
// Types
// ============================================================

export interface AskInput {
  question: string;
  pageContext?: string;
  history?: ChatMessage[];
}

export interface OrchestratorDeps {
  schemaService: SchemaService;
  codeIndexer: CodeIndexer;
  databaseUrl: string;
  registry?: Registry;
  grammarConfig?: { enabled: boolean; confidenceThreshold: number; missLogPath: string };
}

export interface SSEEvent {
  type: 'classifying' | 'classified' | 'sql' | 'executing' | 'token' | 'error' | 'done'
       | 'grammar_matched' | 'grammar_fallback';
  [key: string]: unknown;
}

interface Classification {
  type: QuestionType;
  confidence: number;
  searchTerms?: string[];
}

export interface ManifestRoute {
  path: string;
  method: string;
  label: string;
  component?: string;
  parentPath?: string;
}

export interface ManifestFile {
  path: string;
  content: string;
}

export interface Manifest {
  version: number;
  generatedAt?: string;
  framework?: string;
  routes: ManifestRoute[];
  files: ManifestFile[];
}

// ============================================================
// Orchestrator
// ============================================================

export class Orchestrator {
  private schemaService: SchemaService;
  private codeIndexer: CodeIndexer;
  private databaseUrl: string;
  private manifest: Manifest | null = null;
  private registry?: Registry;
  private grammarConfig?: OrchestratorDeps['grammarConfig'];

  constructor(deps: OrchestratorDeps) {
    this.schemaService = deps.schemaService;
    this.codeIndexer = deps.codeIndexer;
    this.databaseUrl = deps.databaseUrl;
    this.registry = deps.registry;
    this.grammarConfig = deps.grammarConfig;
  }

  setManifest(manifest: Manifest): void {
    if (manifest.version !== 1) {
      console.warn('[sql-chatbot] Unsupported manifest version:', manifest.version);
      return;
    }
    this.manifest = manifest;
  }

  getRouteList(): string {
    return this.buildRouteList();
  }

  searchManifestFiles(terms: string[]): SearchResult[] {
    if (!this.manifest?.files?.length) return [];
    const lowerTerms = terms.map(t => t.toLowerCase());
    const results: SearchResult[] = [];
    for (const file of this.manifest.files) {
      const lowerContent = file.content.toLowerCase();
      const lowerPath = file.path.toLowerCase();
      const contentMatches = lowerTerms.filter(term => lowerContent.includes(term)).length;
      const pathMatches = lowerTerms.filter(term => lowerPath.includes(term)).length;
      const matchCount = contentMatches + pathMatches;
      if (matchCount === 0) continue;
      results.push({ file: file.path, content: file.content, matchCount });
    }
    return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, 10);
  }

  async *handleQuestion(input: AskInput): AsyncGenerator<SSEEvent> {
    const history = input.history ?? [];

    // --- Step 1: Classify ---
    yield { type: 'classifying' };

    const schemaSummary = this.schemaService.getSummary();
    const tableNames = this.schemaService.getTableNames();
    const classifyMessages = buildClassifyMessages({
      question: input.question,
      schemaSummary: tableNames || schemaSummary,
      pageContext: input.pageContext,
      history,
    });

    const classifyRaw = await callLLM(classifyMessages, { jsonMode: true });
    const classification = this.parseClassification(classifyRaw);

    yield {
      type: 'classified',
      questionType: classification.type,
      confidence: classification.confidence,
    };

    // --- Step 2: Route by question type ---
    switch (classification.type) {
      case 'data':
      case 'data_with_code':
        yield* this.handleDataWithCode(input, history, schemaSummary, classification.searchTerms);
        break;

      case 'code':
        yield* this.handleCode(input, history, classification.searchTerms);
        break;

      case 'navigation':
      case 'guidance':
        yield* this.handleNavigationOrGuidance(input, history, classification.type);
        break;

      case 'greeting':
        yield* this.handleGreeting(input, history);
        break;

      case 'unsafe':
        yield { type: 'token', content: "I can't help with that request." };
        break;
    }

    yield { type: 'done' };
  }

  // ============================================================
  // Route handlers
  // ============================================================

  private async *handleData(
    input: AskInput,
    history: ChatMessage[],
    schemaSummary: string,
    codeContext?: string,
    codeSnippets?: CodeSnippet[],
  ): AsyncGenerator<SSEEvent> {
    const questionType: QuestionType = codeContext ? 'data_with_code' : 'data';

    // --- Grammar path (new) ---
    if (this.registry && this.grammarConfig?.enabled) {
      try {
        const grammarResult = await tryGrammarPath({
          question: input.question,
          registry: this.registry,
          history,
          callLLM: (messages) => callLLM(messages, { jsonMode: true }),
          confidenceThreshold: this.grammarConfig.confidenceThreshold,
        });
        if (grammarResult.ok) {
          // Validate + execute BEFORE emitting grammar_matched, so a broken
          // grammar SQL is never user-visible. Falls through to LLM silently
          // on validation, execution, or sanity-check failure.
          const validation = validateSql(grammarResult.sql);
          if (!validation.valid) {
            logMiss(this.grammarConfig.missLogPath, {
              question: input.question,
              reason: `grammar_validation_failed: ${validation.reason}`,
              extracted: grammarResult.intent,
              resultingSql: grammarResult.sql,
            });
            yield { type: 'grammar_fallback', reason: 'grammar_validation_failed' };
          } else {
            yield { type: 'executing' };
            try {
              const execResult = await executeSql(this.databaseUrl, validation.sql!);

              // Sanity-check COUNT result against registry rowCount. Catches
              // "plausible but wrong" answers (e.g., reserved-word silent
              // corruption that returned 1 instead of the real row count).
              const intent = grammarResult.intent as { primitive?: string; entity?: string } | undefined;
              const entityName = intent?.entity ? (this.registry.aliases[intent.entity] ?? intent.entity) : undefined;
              const entity = entityName ? this.registry.entities[entityName] : undefined;
              const sanity = entity && intent?.primitive
                ? checkCountSanity(intent.primitive, entity, execResult.rows)
                : { ok: true };

              if (!sanity.ok) {
                logMiss(this.grammarConfig.missLogPath, {
                  question: input.question,
                  reason: sanity.reason!,
                  extracted: grammarResult.intent,
                  resultingSql: grammarResult.sql,
                });
                yield { type: 'grammar_fallback', reason: 'count_mismatch' };
                // Fall through to LLM — let it produce a fresh answer
              } else {
                // Grammar path committed: emit events + stream answer
                yield { type: 'grammar_matched' };
                yield { type: 'sql', query: validation.sql!, explanation: 'generated by grammar compiler' };
                const enumContext = this.schemaService.extractEnumContext(schemaSummary);
                const answerMessages = buildAnswerMessages({
                  question: input.question,
                  type: questionType,
                  history,
                  sqlResult: execResult.rows,
                  sqlQuery: validation.sql!,
                  codeSnippets,
                  pageContext: input.pageContext,
                  enumContext: enumContext || undefined,
                });
                for await (const chunk of streamLLM(answerMessages)) {
                  yield { type: 'token', content: chunk };
                }
                return; // done
              }
            } catch (execErr) {
              logMiss(this.grammarConfig.missLogPath, {
                question: input.question,
                reason: `grammar_execution_error: ${(execErr as Error).message}`,
                extracted: grammarResult.intent,
                resultingSql: grammarResult.sql,
              });
              yield { type: 'grammar_fallback', reason: 'grammar_execution_error' };
              // fall through
            }
          }
        } else {
          yield { type: 'grammar_fallback', reason: grammarResult.reason };
          logMiss(this.grammarConfig.missLogPath, {
            question: input.question,
            reason: grammarResult.reason,
            extracted: grammarResult.intent,
          });
        }
      } catch (grammarErr) {
        logMiss(this.grammarConfig.missLogPath, {
          question: input.question,
          reason: `grammar_exception: ${(grammarErr as Error).message}`,
          extracted: null,
        });
        // fall through
      }
    }

    // --- EXISTING LLM PATH (unchanged) ---

    // Generate SQL
    const lookupHints = this.schemaService.findLookupHints(input.question);
    const sqlMessages = buildGenerateSqlMessages({
      question: input.question,
      schema: schemaSummary,
      codeContext,
      history,
      lookupHints: lookupHints.length > 0 ? lookupHints : undefined,
    });
    const sqlRaw = await callLLM(sqlMessages, { jsonMode: true });
    const sqlParsed = this.parseSqlGeneration(sqlRaw);

    if (!sqlParsed.sql) {
      yield { type: 'error', message: 'Failed to generate a SQL query for this question.' };
      return;
    }

    yield { type: 'sql', query: sqlParsed.sql, explanation: sqlParsed.explanation };

    // Validate SQL
    const validation = validateSql(sqlParsed.sql);
    if (!validation.valid) {
      yield { type: 'error', message: validation.reason! };
      return;
    }

    // Execute SQL (with two-tier retry on column errors)
    yield { type: 'executing' };

    let sqlResult;
    // Track the SQL actually being executed (may be updated by retry)
    let activeSql = validation.sql!;

    try {
      sqlResult = await executeSql(this.databaseUrl, activeSql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Only retry for column-reference errors
      if (!this.isColumnError(message)) {
        yield { type: 'error', message };
        return;
      }

      // --- Strategy 1: Programmatic column fix (no LLM) ---
      const fixedSql = this.tryFixColumn(message, activeSql, schemaSummary);
      if (fixedSql) {
        const fixedValidation = validateSql(fixedSql);
        if (fixedValidation.valid) {
          activeSql = fixedValidation.sql!;
          yield { type: 'sql', query: activeSql, explanation: '' };
          try {
            sqlResult = await executeSql(this.databaseUrl, activeSql);
          } catch (retryErr) {
            const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
            yield { type: 'error', message: retryMessage };
            return;
          }
        } else {
          // Fixed SQL still didn't validate — fall through to LLM retry
        }
      }

      // --- Strategy 2: LLM retry ---
      if (!sqlResult) {
        const hint = this.buildColumnHint(message, activeSql, schemaSummary);
        // Append error + hint as a new user turn so the LLM understands what went wrong
        const retryMessages = [
          ...sqlMessages,
          { role: 'assistant' as const, content: sqlRaw },
          { role: 'user' as const, content: `The query failed with: ${message}\n${hint}\nPlease fix the SQL query.` },
        ];
        const retryRaw = await callLLM(retryMessages, { jsonMode: true });
        const retryParsed = this.parseSqlGeneration(retryRaw);
        if (!retryParsed.sql) {
          yield { type: 'error', message };
          return;
        }
        const retryValidation = validateSql(retryParsed.sql);
        if (!retryValidation.valid) {
          yield { type: 'error', message: retryValidation.reason! };
          return;
        }
        activeSql = retryValidation.sql!;
        yield { type: 'sql', query: activeSql, explanation: retryParsed.explanation };
        try {
          sqlResult = await executeSql(this.databaseUrl, activeSql);
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          yield { type: 'error', message: retryMessage };
          return;
        }
      }
    }

    // Extract enum context from the selected schema for answer translation
    const enumContext = this.schemaService.extractEnumContext(schemaSummary);

    // Stream answer
    const answerMessages = buildAnswerMessages({
      question: input.question,
      type: questionType,
      history,
      sqlResult: sqlResult.rows,
      sqlQuery: activeSql,
      codeSnippets,
      pageContext: input.pageContext,
      enumContext: enumContext || undefined,
    });

    for await (const chunk of streamLLM(answerMessages)) {
      yield { type: 'token', content: chunk };
    }
  }

  private async *handleDataWithCode(
    input: AskInput,
    history: ChatMessage[],
    schemaSummary: string,
    searchTerms?: string[],
  ): AsyncGenerator<SSEEvent> {
    // Search code index
    const codeResults = this.codeIndexer.search(searchTerms ?? []);
    const manifestResults = this.searchManifestFiles(searchTerms ?? []);
    const allCodeResults = [...codeResults, ...manifestResults]
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, 10);

    const codeContext = this.formatCodeContext(allCodeResults);
    const codeSnippets = this.toCodeSnippets(allCodeResults);

    // Use smart schema selection for SQL generation
    const selectedSchema = this.schemaService.selectSchema(searchTerms ?? []);

    // Delegate to handleData with code context and selected schema
    yield* this.handleData(input, history, selectedSchema || schemaSummary, codeContext, codeSnippets);
  }

  private async *handleCode(
    input: AskInput,
    history: ChatMessage[],
    searchTerms?: string[],
  ): AsyncGenerator<SSEEvent> {
    const results = this.codeIndexer.search(searchTerms ?? []);

    if (results.length === 0) {
      yield { type: 'token', content: "I couldn't find relevant code for that question." };
      return;
    }

    const codeSnippets = this.toCodeSnippets(results);

    const answerMessages = buildAnswerMessages({
      question: input.question,
      type: 'code',
      history,
      codeSnippets,
    });

    for await (const chunk of streamLLM(answerMessages)) {
      yield { type: 'token', content: chunk };
    }
  }

  private async *handleGreeting(
    input: AskInput,
    history: ChatMessage[],
  ): AsyncGenerator<SSEEvent> {
    const answerMessages = buildAnswerMessages({
      question: input.question,
      type: 'greeting',
      history,
    });

    for await (const chunk of streamLLM(answerMessages)) {
      yield { type: 'token', content: chunk };
    }
  }

  private async *handleNavigationOrGuidance(
    input: AskInput,
    history: ChatMessage[],
    type: 'navigation' | 'guidance',
  ): AsyncGenerator<SSEEvent> {
    const routeList = this.buildRouteList();

    const answerMessages = buildAnswerMessages({
      question: input.question,
      type,
      history,
      pageContext: input.pageContext,
      routeList: routeList !== 'No application routes detected.' ? routeList : undefined,
    });

    for await (const chunk of streamLLM(answerMessages)) {
      yield { type: 'token', content: chunk };
    }
  }

  private buildRouteList(): string {
    const routesByPath: Map<string, { path: string; method: string; label?: string; parentPath?: string }> = new Map();
    for (const r of this.codeIndexer.getRoutes()) {
      routesByPath.set(r.path, { path: r.path, method: r.method });
    }
    if (this.manifest?.routes) {
      for (const r of this.manifest.routes) {
        routesByPath.set(r.path, { path: r.path, method: r.method, label: r.label, parentPath: r.parentPath });
      }
    }
    if (routesByPath.size === 0) return 'No application routes detected.';
    const lines = Array.from(routesByPath.values())
      .filter(r => r.method === 'GET')
      .map(r => {
        const parentNote = r.parentPath ? ` (under ${r.parentPath})` : '';
        const label = r.label || r.path.split('/').filter(Boolean).pop() || 'Page';
        return `- ${r.path} \u2014 ${label}${parentNote}`;
      });
    return `## Available Application Pages\n${lines.join('\n')}`;
  }

  // ============================================================
  // Parsing helpers
  // ============================================================

  private parseClassification(raw: string): Classification {
    try {
      const parsed = JSON.parse(raw);
      const validTypes: QuestionType[] = [
        'data', 'data_with_code', 'code', 'navigation', 'guidance', 'greeting', 'unsafe',
      ];
      const type = validTypes.includes(parsed.type) ? parsed.type : 'data';
      return {
        type,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        searchTerms: Array.isArray(parsed.searchTerms) ? parsed.searchTerms : undefined,
      };
    } catch {
      return { type: 'data', confidence: 0.5 };
    }
  }

  private parseSqlGeneration(raw: string): { sql: string; explanation: string } {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.sql || typeof parsed.sql !== 'string') {
        return { sql: '', explanation: parsed.explanation || '' };
      }
      return { sql: parsed.sql, explanation: parsed.explanation || '' };
    } catch {
      // Non-JSON response — don't treat garbled text as SQL
      return { sql: '', explanation: '' };
    }
  }

  // ============================================================
  // Column auto-fix helpers
  // ============================================================

  /**
   * Returns true if the error message indicates an undefined column error
   * (PostgreSQL error code 42703 / "column X does not exist").
   */
  private isColumnError(message: string): boolean {
    return /column .+ does not exist/i.test(message);
  }

  /**
   * Programmatic column fix — no LLM call.
   *
   * Given an error like `column jt.name does not exist` and the original SQL,
   * finds the table backing alias `jt` (e.g. `FROM job_types jt`), looks up
   * that table's columns in the schema string, and tries to replace the bad
   * column with the best available alternative.
   *
   * Returns fixed SQL string or null if a fix cannot be determined.
   */
  private tryFixColumn(errorMessage: string, sql: string, schema: string): string | null {
    // Extract alias and bad column from error: "column jt.name does not exist"
    const colMatch = errorMessage.match(/column\s+(?:(\w+)\.)?(\w+)\s+does not exist/i);
    if (!colMatch) return null;

    const alias = colMatch[1] ?? null;    // e.g. "jt"
    const badCol = colMatch[2];           // e.g. "name"

    // Find the real table name from SQL for the given alias
    let tableName: string | null = null;
    if (alias) {
      // Matches: FROM job_types jt  or  JOIN job_types jt
      const tableMatch = sql.match(new RegExp(
        `(?:FROM|JOIN)\\s+(\\w+)\\s+(?:AS\\s+)?${alias}\\b`,
        'i'
      ));
      tableName = tableMatch ? tableMatch[1] : null;
    }

    // Find available columns for this table in the schema string
    let availableCols: string[] = [];
    if (tableName) {
      // Find the TABLE block for this table in the schema
      // Schema lines look like: "TABLE job_types (id INT PK, title VARCHAR, ...)"
      // or multi-line blocks starting with "TABLE job_types"
      const tableBlockMatch = schema.match(
        new RegExp(`TABLE\\s+${tableName}[\\s\\S]*?(?=TABLE\\s+\\w|$)`, 'i')
      );
      if (tableBlockMatch) {
        // Extract column names: words that appear before type keywords
        const block = tableBlockMatch[0];
        const colMatches = block.matchAll(/\b(\w+)\s+(?:INT|BIGINT|VARCHAR|TEXT|BOOLEAN|TIMESTAMP|DATE|NUMERIC|FLOAT|SERIAL|UUID|JSONB|JSON)\b/gi);
        availableCols = [...colMatches].map((m) => m[1].toLowerCase());
      }
    }

    if (availableCols.length === 0) return null;

    // Preferred replacements for common "name" columns
    const PREFERRED_ALTERNATIVES: Record<string, string[]> = {
      name: ['title', 'label', 'first_name', 'display_name', 'description', 'full_name'],
      full_name: ['name', 'title', 'first_name'],
      label: ['name', 'title', 'description'],
    };

    const preferred = PREFERRED_ALTERNATIVES[badCol.toLowerCase()] ?? [];
    let replacement: string | null = null;

    // Try preferred alternatives first
    for (const pref of preferred) {
      if (availableCols.includes(pref)) {
        replacement = pref;
        break;
      }
    }

    // Fall back to fuzzy: find shortest available column that contains the bad column as substring, or vice versa
    if (!replacement) {
      const fuzzy = availableCols.find(
        (c) => c.includes(badCol.toLowerCase()) || badCol.toLowerCase().includes(c)
      );
      if (fuzzy) replacement = fuzzy;
    }

    if (!replacement) return null;

    // Replace all occurrences of the bad reference in the SQL
    // Handle both aliased (jt.name) and unqualified (name)
    const pattern = alias
      ? new RegExp(`\\b${alias}\\.${badCol}\\b`, 'gi')
      : new RegExp(`\\b${badCol}\\b`, 'gi');

    const fixed = sql.replace(pattern, alias ? `${alias}.${replacement}` : replacement);
    return fixed === sql ? null : fixed;
  }

  /**
   * Builds a hint string for LLM retry on column error.
   *
   * Example output:
   * "HINT: Column 'name' does not exist. Table 'job_types' columns include: id, title, description."
   */
  private buildColumnHint(errorMessage: string, sql: string, schema: string): string {
    const colMatch = errorMessage.match(/column\s+(?:(\w+)\.)?(\w+)\s+does not exist/i);
    if (!colMatch) return `ERROR: ${errorMessage}`;

    const alias = colMatch[1] ?? null;
    const badCol = colMatch[2];

    let tableName: string | null = null;
    if (alias) {
      const tableMatch = sql.match(new RegExp(
        `(?:FROM|JOIN)\\s+(\\w+)\\s+(?:AS\\s+)?${alias}\\b`,
        'i'
      ));
      tableName = tableMatch ? tableMatch[1] : null;
    }

    if (tableName) {
      const tableBlockMatch = schema.match(
        new RegExp(`TABLE\\s+${tableName}[\\s\\S]*?(?=TABLE\\s+\\w|$)`, 'i')
      );
      if (tableBlockMatch) {
        const block = tableBlockMatch[0];
        const colMatches = block.matchAll(/\b(\w+)\s+(?:INT|BIGINT|VARCHAR|TEXT|BOOLEAN|TIMESTAMP|DATE|NUMERIC|FLOAT|SERIAL|UUID|JSONB|JSON)\b/gi);
        const cols = [...colMatches].map((m) => m[1]).join(', ');
        return `HINT: Column '${badCol}' does not exist. Table '${tableName}' columns include: ${cols}.`;
      }
    }

    return `HINT: Column '${badCol}' does not exist. Check the schema for the correct column name.`;
  }

  private formatCodeContext(results: SearchResult[]): string {
    if (results.length === 0) return '';
    return results
      .map((r) => `File: ${r.file}\n${r.content}`)
      .join('\n\n');
  }

  private toCodeSnippets(results: SearchResult[]): CodeSnippet[] {
    return results.map((r) => ({
      filePath: r.file,
      content: r.content,
    }));
  }
}

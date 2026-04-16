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
}

export interface SSEEvent {
  type: 'classifying' | 'classified' | 'sql' | 'executing' | 'token' | 'error' | 'done';
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

  constructor(deps: OrchestratorDeps) {
    this.schemaService = deps.schemaService;
    this.codeIndexer = deps.codeIndexer;
    this.databaseUrl = deps.databaseUrl;
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

    yield { type: 'sql', sql: sqlParsed.sql };

    // Validate SQL
    const validation = validateSql(sqlParsed.sql);
    if (!validation.valid) {
      yield { type: 'error', message: validation.reason! };
      return;
    }

    // Execute SQL
    yield { type: 'executing' };

    let sqlResult;
    try {
      sqlResult = await executeSql(this.databaseUrl, validation.sql!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message };
      return;
    }

    // Extract enum context from the selected schema for answer translation
    const enumContext = this.schemaService.extractEnumContext(schemaSummary);

    // Stream answer
    const answerMessages = buildAnswerMessages({
      question: input.question,
      type: questionType,
      history,
      sqlResult: sqlResult.rows,
      sqlQuery: sqlParsed.sql,
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

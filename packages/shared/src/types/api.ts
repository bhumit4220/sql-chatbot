// Agent REST API request/response types
import type { CodeChunk } from './llm.js';

// Auth
export interface UnlockRequest {
  passphrase: string;
}

export interface UnlockResponse {
  sessionToken: string;
  expiresAt: string;
  extensionId: string;
}

export interface AuthStatusResponse {
  locked: boolean;
  configured: boolean;
  agentVersion: string;
}

// Setup
export interface ConfigureRequest {
  passphraseHash: string;
  encryptedDbUrl: string;
  encryptedGitToken?: string;
  encryptedLlmApiKey?: string;
  salt: string;
  iv: string;
}

export interface RegisterExtensionRequest {
  extensionId: string;
}

// Database
export interface SchemaResponse {
  tables: TableSchema[];
  newSessionToken: string;
}

export interface TableSchema {
  name: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
  foreignKeys: ForeignKeyInfo[];
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  comment?: string;
}

export interface ForeignKeyInfo {
  column: string;
  referredTable: string;
  referredColumn: string;
}

export interface QueryRequest {
  sql: string;
}

export interface QueryResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  totalCount: number;
  executionTimeMs: number;
  newSessionToken: string;
}

// LLM
export interface ClassifyRequest {
  question: string;
  schemaSummary: string;
  pageContext?: string;
  history: { role: string; content: string }[];
}

export interface GenerateSQLRequest {
  question: string;
  schema: string;
  codeContext?: string;
  enums?: string;
  history: { role: string; content: string }[];
}

export interface AnswerRequest {
  question: string;
  sqlResults?: string;
  questionType: string;
  history: { role: string; content: string }[];
  pageContext?: string;
}

export interface AnswerFromCodeRequest {
  question: string;
  codeChunks: CodeChunk[];
  history: { role: string; content: string }[];
  pageContext?: string;
}

// Code
export interface CodeSearchRequest {
  query: string;
  limit?: number;
}

export interface CodeSearchResponse {
  results: CodeChunk[];
  newSessionToken: string;
}

// Discovery
export interface DiscoveryStatusResponse {
  schema: 'pending' | 'running' | 'completed' | 'failed';
  enums: 'pending' | 'running' | 'completed' | 'failed';
  code: 'pending' | 'running' | 'completed' | 'failed';
  tablesFound: number;
  enumsDetected: number;
  filesIndexed: number;
  newSessionToken: string;
}

export interface DiscoveryResultsResponse {
  schema: TableSchema[];
  enums: EnumMapping[];
  relationships: ForeignKeyInfo[];
  staleColumns: string[];
  businessTerms: BusinessTerm[];
  newSessionToken: string;
}

export interface EnumMapping {
  table: string;
  column: string;
  mappings: Record<string, string>;
  description?: string;
}

export interface BusinessTerm {
  term: string;
  meaning: string;
  tables: string[];
}

export interface DiscoveryOverrideRequest {
  type: 'enum' | 'relationship' | 'business_term';
  table: string;
  column?: string;
  corrections: Record<string, string>;
}

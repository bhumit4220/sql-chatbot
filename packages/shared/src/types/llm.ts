// Question types from classifier (6 types — see design doc N7 fix)
export type QuestionType =
  | 'data'           // Simple SQL — schema is enough
  | 'data_with_code' // SQL but needs business logic from code first
  | 'code'           // Answer directly from code, no SQL needed
  | 'navigation'     // Where to find a page/feature
  | 'action'         // Fill form, click, navigate DOM
  | 'guidance';      // How-to, help, capabilities

export interface ClassifyResult {
  type: QuestionType;
  confidence: number;
}

export interface SQLResult {
  sql: string;
  explanation: string;
  confidence: number;
  needsExploration: boolean;
  explorationQuery?: string;
}

export interface LLMEngine {
  classify(question: string, context: ClassifyContext): Promise<ClassifyResult>;
  generateSQL(question: string, context: SQLContext): Promise<SQLResult>;
  streamAnswer(question: string, context: AnswerContext): AsyncIterable<string>;
  streamAnswerFromCode(question: string, context: CodeAnswerContext): AsyncIterable<string>;
  isReady(): Promise<boolean>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ClassifyContext {
  schemaSummary: string;
  pageContext?: string;
  history: ChatMessage[];
}

export interface SQLContext {
  schema: string;
  codeContext?: string;
  enums?: string;
  history: ChatMessage[];
  pageContext?: string;
}

export interface AnswerContext {
  question: string;
  sqlResults: string;
  questionType: QuestionType;
  history: ChatMessage[];
  pageContext?: string;
}

export interface CodeAnswerContext {
  question: string;
  codeChunks: CodeChunk[];
  history: ChatMessage[];
  pageContext?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CodeChunk {
  file: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
}

export interface SqlValidationResult {
  isValid: boolean;
  modifiedSql: string;
  rejectionReason: string;
}

export interface SqlExecutionResult {
  success: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRowCount: number;
  executionTimeMs: number;
  error?: string;
}

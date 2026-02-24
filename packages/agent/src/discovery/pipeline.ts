import type pg from 'pg';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { AGENT_DATA_DIR, DISCOVERY_DB } from '@chatbot/shared';
import type { TableSchema, EnumMapping, BusinessTerm, ForeignKeyInfo } from '@chatbot/shared';
import { inspectSchema } from '../db/schema-inspector.js';
import { detectEnumCandidates } from './data-sampler.js';
import { inferEnumLabelsFromCode } from './label-inference.js';

const DB_PATH = join(homedir(), AGENT_DATA_DIR, DISCOVERY_DB);

export interface DiscoveryState {
  schema: 'pending' | 'running' | 'completed' | 'failed';
  enums: 'pending' | 'running' | 'completed' | 'failed';
  code: 'pending' | 'running' | 'completed' | 'failed';
  tablesFound: number;
  enumsDetected: number;
  filesIndexed: number;
}

let state: DiscoveryState = {
  schema: 'pending',
  enums: 'pending',
  code: 'pending',
  tablesFound: 0,
  enumsDetected: 0,
  filesIndexed: 0,
};

let cachedSchema: TableSchema[] = [];
let cachedEnums: EnumMapping[] = [];
let cachedBusinessTerms: BusinessTerm[] = [];

function initDiscoveryDb(): Database.Database {
  // Ensure data directory exists
  const dataDir = join(homedir(), AGENT_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });

  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS enum_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      UNIQUE(table_name, column_name, value)
    );
    CREATE TABLE IF NOT EXISTS business_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL UNIQUE,
      meaning TEXT NOT NULL,
      tables TEXT NOT NULL
    );
  `);
  return db;
}

export function getState(): DiscoveryState {
  return { ...state };
}

export function resetState(): void {
  state = {
    schema: 'pending',
    enums: 'pending',
    code: 'pending',
    tablesFound: 0,
    enumsDetected: 0,
    filesIndexed: 0,
  };
  cachedSchema = [];
  cachedEnums = [];
  cachedBusinessTerms = [];
}

export async function runDiscovery(pool: pg.Pool): Promise<void> {
  // Phase 1: Schema scan
  state.schema = 'running';
  try {
    cachedSchema = await inspectSchema(pool);
    state.tablesFound = cachedSchema.length;
    state.schema = 'completed';
  } catch {
    state.schema = 'failed';
    return;
  }

  // Phase 2: Enum detection
  state.enums = 'running';
  try {
    const pkSet = new Set<string>();
    const fkSet = new Set<string>();
    for (const table of cachedSchema) {
      for (const pk of table.primaryKeys) {
        pkSet.add(`${table.name}.${pk}`);
      }
      for (const fk of table.foreignKeys) {
        fkSet.add(`${table.name}.${fk.column}`);
      }
    }

    const candidates = await detectEnumCandidates(pool, pkSet, fkSet);
    cachedEnums = inferEnumLabelsFromCode(candidates);
    state.enumsDetected = cachedEnums.length;

    // Apply overrides from DB
    const db = initDiscoveryDb();
    const overrides = db.prepare('SELECT * FROM enum_overrides').all() as {
      table_name: string;
      column_name: string;
      value: string;
      label: string;
    }[];
    for (const override of overrides) {
      const enumMapping = cachedEnums.find(
        e => e.table === override.table_name && e.column === override.column_name
      );
      if (enumMapping) {
        enumMapping.mappings[override.value] = override.label;
      }
    }
    db.close();

    state.enums = 'completed';
  } catch {
    state.enums = 'failed';
  }

  // Phase 3: Code status (depends on whether indexing has been run)
  state.code = 'completed'; // Assumes code index was already built
}

export function getResults(): {
  schema: TableSchema[];
  enums: EnumMapping[];
  relationships: ForeignKeyInfo[];
  staleColumns: string[];
  businessTerms: BusinessTerm[];
} {
  return {
    schema: cachedSchema,
    enums: cachedEnums,
    relationships: cachedSchema.flatMap(t => t.foreignKeys),
    staleColumns: [],
    businessTerms: cachedBusinessTerms,
  };
}

export function applyOverride(override: {
  type: 'enum' | 'relationship' | 'business_term';
  table: string;
  column?: string;
  corrections: Record<string, string>;
}): void {
  const db = initDiscoveryDb();

  if (override.type === 'enum' && override.column) {
    const upsert = db.prepare(`
      INSERT INTO enum_overrides (table_name, column_name, value, label)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(table_name, column_name, value)
      DO UPDATE SET label = excluded.label
    `);

    for (const [value, label] of Object.entries(override.corrections)) {
      upsert.run(override.table, override.column, value, label);
    }

    // Update cached enums
    const enumMapping = cachedEnums.find(
      e => e.table === override.table && e.column === override.column
    );
    if (enumMapping) {
      Object.assign(enumMapping.mappings, override.corrections);
    }
  }

  if (override.type === 'business_term') {
    const upsert = db.prepare(`
      INSERT INTO business_terms (term, meaning, tables)
      VALUES (?, ?, ?)
      ON CONFLICT(term) DO UPDATE SET meaning = excluded.meaning, tables = excluded.tables
    `);

    for (const [term, meaning] of Object.entries(override.corrections)) {
      upsert.run(term, meaning, override.table);
    }
  }

  db.close();
}

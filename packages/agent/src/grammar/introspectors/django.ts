import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRegistry, Registry, Field, Association } from '../registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DjangoRawEntity {
  name: string;
  class: string;
  table: string;
  fields: Record<string, { type: string; enum_values?: Record<string, number | string> }>;
  fks: Array<{ field: string; target: string }>;
}

function runPython(projectPath: string): Promise<{ entities: DjangoRawEntity[] }> {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'scripts', 'django_introspect.py');
    const proc = spawn('python3', [script, projectPath]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => reject(new Error(`python3 spawn failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`django_introspect exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`malformed python output: ${(e as Error).message}`));
      }
    });
  });
}

export async function introspectDjango(projectPath: string): Promise<Registry> {
  const raw = await runPython(projectPath);
  const r = createRegistry({ framework: 'django' });
  const classToEntityName: Record<string, string> = {};
  const classToTable: Record<string, string> = {};

  for (const e of raw.entities) {
    classToEntityName[e.class] = e.name;
    classToTable[e.class] = e.table;
  }

  for (const e of raw.entities) {
    const fields: Record<string, Field> = {};
    for (const [fieldName, f] of Object.entries(e.fields)) {
      const isFkField = e.fks.some((fk) => fk.field === fieldName);
      fields[fieldName] = {
        column: isFkField ? `${fieldName}_id` : fieldName,
        type: f.type as Field['type'],
        nullable: false,
        enumValues: f.enum_values,
        searchable: f.type === 'text',
      };
    }
    const associations: Record<string, Association> = {};
    for (const fk of e.fks) {
      const targetEntity = classToEntityName[fk.target];
      const targetTable = classToTable[fk.target];
      if (!targetEntity || !targetTable) continue;
      associations[targetEntity] = {
        name: targetEntity,
        kind: 'belongs_to',
        targetEntity,
        joinClause: `${e.table}.${fk.field}_id = ${targetTable}.id`,
      };
    }
    r.entities[e.name] = {
      name: e.name,
      table: e.table,
      displayLabel: e.class,
      rowCount: 0,
      primaryKey: 'id',
      timestamps: {},
      fields,
      scopes: {},
      associations,
      rankingCandidates: Object.entries(fields)
        .filter(([_, f]) => ['int', 'decimal', 'timestamp'].includes(f.type))
        .map(([n]) => n),
    };
  }

  return r;
}

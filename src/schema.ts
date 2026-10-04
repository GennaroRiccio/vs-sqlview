export interface SchemaColumn {
  name: string;
  /** Tipo SQL normalizzato in maiuscolo: VARCHAR, NVARCHAR, CHAR, NCHAR, TEXT, NTEXT ... */
  dataType?: string;
}

export interface SchemaTable {
  name: string;
  columns: string[];
  /** Mappa nome-colonna-lowercase -> tipo normalizzato (solo se noto dal DDL o dal DB). */
  columnTypes: Record<string, string>;
}

export interface SchemaInfo {
  tables: Record<string, SchemaTable>;
}

const NON_COLUMN_LEADS = new Set([
  'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'INDEX', 'EXCLUDE',
]);

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let str: string | null = null;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (str) {
      current += ch;
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Estrae tabelle, colonne e tipi dai CREATE TABLE presenti in uno script DDL. */
export function parseSchema(ddl: string): SchemaInfo {
  const tables: Record<string, SchemaTable> = {};
  const noComments = ddl.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    const tableName = m[2];
    let depth = 0;
    let j = re.lastIndex - 1;
    for (; j < noComments.length; j++) {
      if (noComments[j] === '(') depth++;
      else if (noComments[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = noComments.slice(re.lastIndex, j);
    const columns: string[] = [];
    const columnTypes: Record<string, string> = {};
    for (const def of splitTopLevel(body)) {
      const cm = def.trim().match(/^"?(\w+)"?\s+([A-Za-z]+)(?:\s*\(\s*[\d\s,]+\s*(?:\s+(?:CHAR|BYTE))?\s*\))?/);
      if (!cm) continue;
      if (NON_COLUMN_LEADS.has(cm[1].toUpperCase())) continue;
      columns.push(cm[1]);
      if (cm[2]) {
        const t = cm[2].toUpperCase();
        if (isStringType(t)) columnTypes[cm[1].toLowerCase()] = t;
      }
    }
    tables[tableName.toLowerCase()] = { name: tableName, columns, columnTypes };
  }
  return { tables };
}

/** True per i tipi stringa rilevanti al check VARCHAR/NVARCHAR (SQL Server / T-SQL). */
export function isStringType(t: string): boolean {
  return ['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'TEXT', 'NTEXT'].includes(t.toUpperCase());
}

/** True se il tipo è Unicode (NCHAR/NVARCHAR/NTEXT): i letterali devono usare il prefisso N'...'. */
export function isUnicodeType(t: string | undefined): boolean {
  if (!t) return false;
  return ['NVARCHAR', 'NCHAR', 'NTEXT'].includes(t.toUpperCase());
}

/** Fonde i tipi colonna provenienti dal DB (INFORMATION_SCHEMA) nello schema DDL. */
export function mergeDbColumnTypes(schema: SchemaInfo, dbTypes: Record<string, Record<string, string>>): SchemaInfo {
  for (const [table, cols] of Object.entries(dbTypes)) {
    const key = table.toLowerCase();
    const entry = schema.tables[key];
    if (entry) {
      for (const [col, type] of Object.entries(cols)) {
        entry.columnTypes[col.toLowerCase()] = type.toUpperCase();
        if (!entry.columns.map((c) => c.toLowerCase()).includes(col.toLowerCase())) {
          entry.columns.push(col);
        }
      }
    } else {
      const columns = Object.keys(cols);
      const columnTypes: Record<string, string> = {};
      for (const [col, type] of Object.entries(cols)) {
        columnTypes[col.toLowerCase()] = type.toUpperCase();
      }
      schema.tables[key] = { name: table, columns, columnTypes };
    }
  }
  return schema;
}

export function schemaTableCount(schema: SchemaInfo): number {
  return Object.keys(schema.tables).length;
}

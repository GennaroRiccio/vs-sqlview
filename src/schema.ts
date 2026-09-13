export interface SchemaTable {
  name: string;
  columns: string[];
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

/** Estrae tabelle e colonne dai CREATE TABLE presenti in uno script DDL. */
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
    for (const def of splitTopLevel(body)) {
      const cm = def.trim().match(/^"?(\w+)"?/);
      if (!cm) continue;
      if (NON_COLUMN_LEADS.has(cm[1].toUpperCase())) continue;
      columns.push(cm[1]);
    }
    tables[tableName.toLowerCase()] = { name: tableName, columns };
  }
  return { tables };
}

export function schemaTableCount(schema: SchemaInfo): number {
  return Object.keys(schema.tables).length;
}

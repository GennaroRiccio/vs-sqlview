import { SqlQueryPlan } from './sqlParser';
import { SchemaInfo, isUnicodeType } from './schema';
import { PerformanceIssue } from './performanceAnalyzer';

export interface NvarcharLiteral {
  /** Testo completo del letterale incluso l'eventuale prefisso N, es. N'nome' o 'nome'. */
  text: string;
  /** True se il letterale usa il prefisso N (Unicode). */
  isUnicode: boolean;
  /** Offset nello script SQL originale. */
  offset: number;
}

export interface NvarcharMismatch {
  table: string;
  column: string;
  columnType: string;
  literal: string;
  literalIsUnicode: boolean;
  /** Direzione della conversione implicita. */
  kind: 'varchar-col-n-literal' | 'nvarchar-col-plain-literal';
}

/**
 * Estrae tutti i letterali stringa dallo script, distinguendo N'...' (Unicode)
 * da '...' (non-Unicode). Rispetta l'escape '' e ignora i commenti.
 */
export function extractStringLiterals(sql: string): NvarcharLiteral[] {
  const out: NvarcharLiteral[] = [];
  const noComments = sql
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const re = /(N?)'((?:[^']|'')*)'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    out.push({
      text: m[0],
      isUnicode: m[1].toUpperCase() === 'N',
      offset: m.index,
    });
  }
  return out;
}

/** True se lo script contiene almeno un letterale Unicode N'...'. */
export function hasNvarcharLiteral(sql: string): boolean {
  return extractStringLiterals(sql).some((l) => l.isUnicode);
}

function buildAliasMap(plan: SqlQueryPlan): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of plan.tables) {
    map.set(t.name.toLowerCase(), t.name);
    if (t.alias) map.set(t.alias.toLowerCase(), t.name);
  }
  return map;
}

function columnTypeOf(
  table: string | undefined,
  column: string,
  schema: SchemaInfo | undefined
): string | undefined {
  if (!table || !schema) return undefined;
  const entry = schema.tables[table.toLowerCase()];
  if (!entry || !entry.columnTypes) return undefined;
  return entry.columnTypes[column.toLowerCase()];
}

/**
 * Confronta ogni predicato/colonna di tipo stringa con il letterale usato nel
 * confronto e segnala le incoerenze VARCHAR/NVARCHAR che in SQL Server
 * provocano CONVERT_IMPLICIT e invalidano l'uso degli indici.
 *
 * - colonna VARCHAR + letterale N'...'  -> conversione implicita sulla colonna (critico per le performance)
 * - colonna NVARCHAR + letterale '...'  -> confronto misto, rischio perdita dati/collation + mancato uso ottimale indice
 */
export function findNvarcharMismatches(plan: SqlQueryPlan, schema?: SchemaInfo): NvarcharMismatch[] {
  const out: NvarcharMismatch[] = [];
  if (!schema) return out;
  const aliasMap = buildAliasMap(plan);
  const resolve = (ref: string): string | undefined => aliasMap.get(ref.toLowerCase());
  const defaultTable = plan.tables.length === 1 ? plan.tables[0].name : undefined;

  const checkCondition = (cond: string) => {
    // Pattern: [alias.]colonna OP N?'letterale'  (OP: = <> != < > <= >= LIKE IN)
    const re = /(?:(\w+)\.)?(\w+)\s*(=|<>|!=|<|>|<=|>=|LIKE\b|IN\b)\s*(N?)'((?:[^']|'')*)'/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cond)) !== null) {
      const qualifier = m[1];
      const col = m[2];
      const literalIsUnicode = m[4].toUpperCase() === 'N';
      const table = qualifier ? resolve(qualifier) : defaultTable;
      if (!table) continue;
      const colType = columnTypeOf(table, col, schema);
      if (!colType) continue;
      const colIsUnicode = isUnicodeType(colType);
      if (!colIsUnicode && literalIsUnicode) {
        out.push({
          table,
          column: col,
          columnType: colType,
          literal: m[0],
          literalIsUnicode,
          kind: 'varchar-col-n-literal',
        });
      } else if (colIsUnicode && !literalIsUnicode) {
        out.push({
          table,
          column: col,
          columnType: colType,
          literal: m[0],
          literalIsUnicode,
          kind: 'nvarchar-col-plain-literal',
        });
      }
    }
  };

  for (const c of plan.whereConditions) checkCondition(c);
  for (const c of plan.havingConditions) checkCondition(c);
  for (const t of plan.tables) {
    if (t.joinCondition) checkCondition(t.joinCondition);
  }

  // Deduplica per tabella+colonna+kind
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.table.toLowerCase()}.${x.column.toLowerCase()}#${x.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Converte i mismatch in PerformanceIssue con codici diagnostici dedicati.
 */
export function nvarcharIssuesFor(plan: SqlQueryPlan, schema?: SchemaInfo): PerformanceIssue[] {
  const issues: PerformanceIssue[] = [];
  const mismatches = findNvarcharMismatches(plan, schema);
  for (const mm of mismatches) {
    if (mm.kind === 'varchar-col-n-literal') {
      issues.push({
        severity: 'warning',
        message: `Conversione implicita VARCHAR/NVARCHAR su "${mm.table}.${mm.column}" (${mm.columnType}) confrontata con letterale N'...'`,
        suggestion:
          `La colonna è ${mm.columnType} ma il letterale usa il prefisso N: SQL Server applica CONVERT_IMPLICIT sulla colonna e l'indice non viene usato (index scan). ` +
          `Rimuovere il prefisso N dal letterale oppure alterare la colonna in NVARCHAR se deve contenere Unicode.`,
        code: 'NVARCHAR_VARCHAR_MISMATCH',
      });
    } else {
      issues.push({
        severity: 'info',
        message: `Letterale non-Unicode su colonna Unicode "${mm.table}.${mm.column}" (${mm.columnType})`,
        suggestion:
          `La colonna è ${mm.columnType} ma il letterale non usa il prefisso N: aggiungere N davanti al letterale (N'...') ` +
          `per coerenza di tipo, collation ed uso ottimale dell'indice.`,
        code: 'NVARCHAR_PLAIN_ON_UNICODE',
      });
    }
  }

  // Presenza informativa di letterali N'...' senza tipo colonna noto (es. senza DB): guida l'utente a collegare il DB.
  if (mismatches.length === 0 && hasNvarcharLiteral(plan.rawQuery)) {
    const anyKnown = schema
      ? Object.values(schema.tables).some((t) => t.columnTypes && Object.keys(t.columnTypes).length > 0)
      : false;
    if (!anyKnown) {
      issues.push({
        severity: 'info',
        message: `Letterale Unicode N'...' rilevato: tipi colonna non noti, impossibile verificare la coerenza`,
        suggestion:
          `Lo script usa N'...' ma nessun tipo colonna è noto (né dal DDL né dal DB). ` +
          `Configurare la connessione al DB (vs-sqlview.db.*) ed eseguire "VS-SQLView: Refresh DB Schema" ` +
          `oppure aggiungere i CREATE TABLE con i tipi nel file di schema per abilitare il controllo VARCHAR/NVARCHAR.`,
        code: 'NVARCHAR_UNKNOWN_TYPES',
      });
    }
  }
  return issues;
}

import { SqlQueryPlan } from './sqlParser';
import { SchemaInfo, schemaTableCount } from './schema';

export interface PerformanceIssue {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  suggestion: string;
  code?: string;
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  ddl: string;
  reason: string;
}

export interface CategoryScore {
  name: string;
  score: number;
}

export interface QueryScore {
  total: number;
  grade: string;
  categories: CategoryScore[];
}

export interface AnalysisResult {
  issues: PerformanceIssue[];
  indexes: IndexSuggestion[];
  score: QueryScore;
}

const CODE_CATEGORY: Record<string, string> = {
  MISSING_WHERE: 'Filtri',
  LIKE_INDEX: 'Filtri',
  OR_CONDITION: 'Filtri',
  OR_IN_WHERE: 'Filtri',
  FUNCTION_ON_WHERE: 'Filtri',
  NOT_IN_NULL: 'Filtri',
  MANY_JOINS: 'Join',
  SUBQUERY: 'Join',
  SCALAR_SUBQUERY: 'Join',
  CROSS_JOIN: 'Join',
  SELECT_STAR: 'Proiezione',
  FUNCTION_ON_COLUMN: 'Proiezione',
  DISTINCT: 'Proiezione',
  UNION_ALL: 'Proiezione',
  ORDER_BY_NO_LIMIT: 'Ordinamento',
  MISSING_LIMIT: 'Ordinamento',
  HAVING_NO_GROUP: 'Struttura',
  DML_NO_WHERE: 'Struttura',
  INSERT_NO_COLS: 'Struttura',
  UNKNOWN_TABLE: 'Struttura',
  UNKNOWN_COLUMN: 'Struttura',
};

export class PerformanceAnalyzer {
  analyze(plan: SqlQueryPlan): PerformanceIssue[] {
    return this.analyzeFull(plan).issues;
  }

  analyzeFull(plan: SqlQueryPlan, schema?: SchemaInfo): AnalysisResult {
    const issues: PerformanceIssue[] = [];

    this.checkSelectStar(plan, issues);
    this.checkMissingWhere(plan, issues);
    this.checkMissingLimit(plan, issues);
    this.checkMissingIndex(plan, issues);
    this.checkSubqueryPerformance(plan, issues);
    this.checkScalarSubquery(plan, issues);
    this.checkFunctionOnColumn(plan, issues);
    this.checkFunctionOnWhere(plan, issues);
    this.checkOrderByWithoutLimit(plan, issues);
    this.checkMultipleJoins(plan, issues);
    this.checkDistinctUsage(plan, issues);
    this.checkOrConditions(plan, issues);
    this.checkOrDifferentColumns(plan, issues);
    this.checkNotInNull(plan, issues);
    this.checkHavingWithoutGroupBy(plan, issues);
    this.checkDmlWithoutWhere(plan, issues);
    this.checkCrossJoin(plan, issues);
    this.checkUnionAll(plan, issues);
    this.checkInsertWithoutColumns(plan, issues);
    if (schema && schemaTableCount(schema) > 0) {
      this.validateSchema(plan, schema, issues);
    }

    const indexes = this.suggestIndexes(plan, schema);
    const score = this.computeScore(issues);

    return { issues, indexes, score };
  }

  computeScore(issues: PerformanceIssue[]): QueryScore {
    const cats: Record<string, number> = {
      Filtri: 100,
      Join: 100,
      Proiezione: 100,
      Ordinamento: 100,
      Struttura: 100,
    };
    let total = 100;

    for (const issue of issues) {
      const cat = (issue.code && CODE_CATEGORY[issue.code]) || 'Struttura';
      const catPenalty = issue.severity === 'critical' ? 25 : issue.severity === 'warning' ? 10 : 4;
      const totalPenalty = issue.severity === 'critical' ? 20 : issue.severity === 'warning' ? 8 : 3;
      cats[cat] = Math.max(0, cats[cat] - catPenalty);
      total = Math.max(0, total - totalPenalty);
    }

    const categories: CategoryScore[] = Object.keys(cats).map((name) => ({ name, score: cats[name] }));
    const grade = total >= 90 ? 'A' : total >= 75 ? 'B' : total >= 60 ? 'C' : total >= 40 ? 'D' : 'F';

    return { total, grade, categories };
  }

  suggestIndexes(plan: SqlQueryPlan, schema?: SchemaInfo): IndexSuggestion[] {
    const suggestions: IndexSuggestion[] = [];
    const seen = new Set<string>();
    const aliasMap = this.buildAliasMap(plan);
    const knownOnly = !!schema && schemaTableCount(schema) > 0;
    const isKnown = (t: string) => !knownOnly || !!schema!.tables[t.toLowerCase()];

    const push = (table: string, columns: string[], reason: string) => {
      const t = table.toLowerCase();
      if (!isKnown(t)) return;
      const cols = columns.map((c) => c.toLowerCase());
      const key = `${t}(${cols.join(',')})`;
      if (seen.has(key)) return;
      seen.add(key);
      suggestions.push({
        table,
        columns,
        ddl: `CREATE INDEX idx_${t}_${cols.join('_')} ON ${table} (${cols.join(', ')});`,
        reason,
      });
    };

    const whereEqColsByTable = new Map<string, { cols: string[]; table: string }>();

    for (const cond of plan.whereConditions) {
      const m = cond.match(/^(?:(\w+)\.)?(\w+)\s*(=|IN\b|BETWEEN\b|>|<|>=|<=|LIKE\b)/i);
      if (!m) continue;
      const ref = m[1] ? this.resolveTable(m[1], aliasMap) : this.defaultTable(plan);
      const col = m[2];
      if (!ref || this.isKeyword(col)) continue;
      const op = m[3].toUpperCase();

      if (op === 'LIKE') {
        const lit = cond.match(/LIKE\s+'([^']*)'/i);
        if (lit && !lit[1].startsWith('%')) {
          push(ref, [col], `LIKE con prefisso '${lit[1].slice(0, 12)}…' può usare un indice B-tree.`);
        }
        continue;
      }

      push(ref, [col], `Colonna filtrata in WHERE (${op.trim()}).`);

      if (op === '=' || op === 'IN') {
        const entry = whereEqColsByTable.get(ref.toLowerCase()) ?? { cols: [], table: ref };
        if (!entry.cols.map((c) => c.toLowerCase()).includes(col.toLowerCase()) && entry.cols.length < 3) {
          entry.cols.push(col);
        }
        whereEqColsByTable.set(ref.toLowerCase(), entry);
      }
    }

    for (const entry of whereEqColsByTable.values()) {
      if (entry.cols.length >= 2) {
        push(entry.table, entry.cols, 'Indice composto: condizioni AND in uguaglianza sulla stessa tabella.');
      }
    }

    for (const t of plan.tables) {
      if (!t.joinCondition) continue;
      const jm = t.joinCondition.match(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/);
      if (!jm) continue;
      const left = this.resolveTable(jm[1], aliasMap);
      const right = this.resolveTable(jm[3], aliasMap);
      if (left) push(left, [jm[2]], `Colonna usata nella condizione di JOIN (${t.joinType ?? ''} JOIN).`);
      if (right) push(right, [jm[4]], `Colonna usata nella condizione di JOIN (${t.joinType ?? ''} JOIN).`);
    }

    const firstOf = (list: string[]): { table: string; col: string } | undefined => {
      if (list.length === 0) return undefined;
      const m = list[0].match(/^(?:(\w+)\.)?(\w+)/);
      if (!m || this.isKeyword(m[2])) return undefined;
      const table = m[1] ? this.resolveTable(m[1], aliasMap) : this.defaultTable(plan);
      return table ? { table, col: m[2] } : undefined;
    };

    const ob = firstOf(plan.orderByColumns);
    if (ob) push(ob.table, [ob.col], 'Colonna di ORDER BY: evita il sort su disco.');
    const gb = firstOf(plan.groupByColumns);
    if (gb) push(gb.table, [gb.col], 'Colonna di GROUP BY: velocizza raggruppamento e aggregate.');

    return suggestions.slice(0, 6);
  }

  private buildAliasMap(plan: SqlQueryPlan): Map<string, string> {
    const map = new Map<string, string>();
    for (const t of plan.tables) {
      map.set(t.name.toLowerCase(), t.name);
      if (t.alias) map.set(t.alias.toLowerCase(), t.name);
    }
    return map;
  }

  private resolveTable(ref: string, aliasMap: Map<string, string>): string | undefined {
    return aliasMap.get(ref.toLowerCase());
  }

  private defaultTable(plan: SqlQueryPlan): string | undefined {
    return plan.tables.length === 1 ? plan.tables[0].name : undefined;
  }

  private isKeyword(word: string): boolean {
    return ['AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'ELSE', 'END', 'DISTINCT', 'ALL'].includes(word.toUpperCase());
  }

  private checkSelectStar(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.columns.some((c) => c.name === '*')) {
      issues.push({
        severity: 'warning',
        message: 'Uso di SELECT * rilevato',
        suggestion: 'Evitare SELECT * e specificare solo le colonne necessarie per ridurre il trasferimento di dati e migliorare le performance.',
        code: 'SELECT_STAR',
      });
    }
  }

  private checkMissingWhere(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.type === 'SELECT' && plan.whereConditions.length === 0 && !plan.hasSubquery) {
      issues.push({
        severity: 'critical',
        message: 'Query SELECT senza clausola WHERE',
        suggestion: 'Aggiungere una clausola WHERE per limitare il numero di righe restituite e migliorare le performance.',
        code: 'MISSING_WHERE',
      });
    }
  }

  private checkMissingLimit(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.type === 'SELECT' && !plan.limit && plan.tables.length > 0) {
      issues.push({
        severity: 'info',
        message: 'Query senza LIMIT',
        suggestion: 'Considerare di aggiungere LIMIT per limitare il numero di righe restituite, soprattutto durante lo sviluppo.',
        code: 'MISSING_LIMIT',
      });
    }
  }

  private checkMissingIndex(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    for (const condition of plan.whereConditions) {
      const upper = condition.toUpperCase();
      if (upper.includes('LIKE')) {
        const lit = condition.match(/LIKE\s+'([^']*)'/i);
        const leadingWildcard = lit && lit[1].startsWith('%');
        issues.push({
          severity: leadingWildcard ? 'critical' : 'warning',
          message: leadingWildcard ? 'LIKE con wildcard iniziale: indice inutilizzabile' : 'Uso di LIKE rilevato nelle condizioni WHERE',
          suggestion: leadingWildcard
            ? 'Un pattern che inizia con % non può usare indici B-tree: la query fa full scan. Valutare indici FULLTEXT/trigram o riscrivere il filtro.'
            : 'LIKE con prefisso fisso può usare un indice B-tree. Verificare che esista un indice sulla colonna.',
          code: 'LIKE_INDEX',
        });
      }
    }
  }

  private checkSubqueryPerformance(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.hasSubquery) {
      issues.push({
        severity: 'warning',
        message: 'Subquery rilevata',
        suggestion: 'Le subquery possono essere meno efficienti dei JOIN. Considerare la riscrittura della query usando JOIN.',
        code: 'SUBQUERY',
      });
    }
  }

  private checkScalarSubquery(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (/SELECT[\s\S]*\(\s*SELECT/i.test(plan.rawQuery)) {
      issues.push({
        severity: 'warning',
        message: 'Subquery scalare nella SELECT: rischio N+1',
        suggestion: 'Una subquery nella lista SELECT viene eseguita una volta per riga (pattern N+1). Riscriverla con JOIN laterale o aggregazione pre-calcolata.',
        code: 'SCALAR_SUBQUERY',
      });
    }
  }

  private checkFunctionOnColumn(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    for (const col of plan.columns) {
      if (col.name && col.name.match(/\b\w+\s*\(/)) {
        issues.push({
          severity: 'info',
          message: `Funzione applicata alla colonna: ${col.name.slice(0, 60)}`,
          suggestion: "Applicare funzioni sulle colonne può impedire l'utilizzo degli indici. Considerare colonne calcolate o indici funzionanti.",
          code: 'FUNCTION_ON_COLUMN',
        });
      }
    }
  }

  private checkFunctionOnWhere(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    for (const cond of plan.whereConditions) {
      if (/\b\w+\s*\([^)]*\)\s*(=|<>|!=|<|>|<=|>=|LIKE\b)/i.test(cond)) {
        issues.push({
          severity: 'warning',
          message: `Funzione su colonna in WHERE: ${cond.slice(0, 60)}`,
          suggestion: "Una funzione applicata alla colonna nel WHERE rende l'indice inutilizzabile (es. YEAR(data) = 2024 → usare data >= '2024-01-01' AND data < '2025-01-01').",
          code: 'FUNCTION_ON_WHERE',
        });
        break;
      }
    }
  }

  private checkOrderByWithoutLimit(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.orderByColumns.length > 0 && !plan.limit && plan.tables.length > 0) {
      issues.push({
        severity: 'info',
        message: 'ORDER BY senza LIMIT',
        suggestion: "L'ordinamento di grandi quantità di dati senza LIMIT può essere costoso. Considerare di aggiungere LIMIT.",
        code: 'ORDER_BY_NO_LIMIT',
      });
    }
  }

  private checkMultipleJoins(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.tables.length > 3) {
      issues.push({
        severity: 'warning',
        message: `Molti JOIN rilevati (${plan.tables.length} tabelle)`,
        suggestion: 'Un numero elevato di JOIN può rallentare la query. Considerare di denormalizzare o utilizzare indici composti.',
        code: 'MANY_JOINS',
      });
    }
  }

  private checkDistinctUsage(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.rawQuery.toUpperCase().includes('SELECT DISTINCT')) {
      issues.push({
        severity: 'info',
        message: 'Uso di DISTINCT rilevato',
        suggestion: 'DISTINCT può essere costoso. Assicurarsi che sia necessario o considerare GROUP BY.',
        code: 'DISTINCT',
      });
    }
  }

  private checkOrConditions(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    const orConditions = plan.whereConditions.filter((c) => c.toUpperCase().includes(' OR '));
    if (orConditions.length > 0 || /\sOR\s/i.test(this.rawWhereClause(plan))) {
      issues.push({
        severity: 'warning',
        message: 'Condizioni OR nelle WHERE',
        suggestion: "Le condizioni OR possono impedire l'utilizzo degli indici. Considerare UNION o indici composti.",
        code: 'OR_IN_WHERE',
      });
    }
  }

  private rawWhereClause(plan: SqlQueryPlan): string {
    const m = plan.rawQuery.match(/\bWHERE\s+([\s\S]+?)(?=\s+GROUP\s+BY\b|\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i);
    return m ? m[1] : '';
  }

  private checkOrDifferentColumns(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    const clauses = [...plan.whereConditions, this.rawWhereClause(plan)].filter((c) => /\sOR\s/i.test(c));
    for (const cond of clauses) {
      const parts = cond.split(/\s+OR\s+/i);
      if (parts.length < 2) continue;
      const cols = new Set<string>();
      for (const p of parts) {
        const m = p.match(/(?:(\w+)\.)?(\w+)\s*(=|<|>|<=|>=|LIKE\b|IN\b)/i);
        if (m) {
          cols.add(`${(m[1] ?? '').toLowerCase()}.${m[2].toLowerCase()}`);
          continue;
        }
        const f = p.match(/\b\w+\(\s*(?:(\w+)\.)?(\w+)\s*\)/);
        if (f) cols.add(`${(f[1] ?? '').toLowerCase()}.${f[2].toLowerCase()}`);
      }
      if (cols.size > 1) {
        issues.push({
          severity: 'warning',
          message: 'OR su colonne diverse: nessun indice singolo aiuta',
          suggestion: "OR su colonne diverse impedisce l'uso efficiente degli indici. Riscrivere con UNION ALL di due query indicizzate oppure creare indici su entrambe le colonne.",
          code: 'OR_CONDITION',
        });
        break;
      }
    }
  }

  private checkNotInNull(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (/\bNOT\s+IN\s*\(/i.test(plan.rawQuery)) {
      issues.push({
        severity: 'warning',
        message: 'NOT IN rilevato: pericolo NULL',
        suggestion: 'Se la lista contiene un NULL (o la subquery restituisce NULL), NOT IN non restituisce alcuna riga. Preferire NOT EXISTS, che è NULL-safe e spesso più veloce.',
        code: 'NOT_IN_NULL',
      });
    }
  }

  private checkHavingWithoutGroupBy(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.havingConditions.length > 0 && plan.groupByColumns.length === 0) {
      issues.push({
        severity: 'warning',
        message: 'HAVING senza GROUP BY',
        suggestion: 'HAVING senza GROUP BY tratta tutta la tabella come un unico gruppo: spesso è un errore logico. Verificare se serviva WHERE oppure aggiungere GROUP BY.',
        code: 'HAVING_NO_GROUP',
      });
    }
  }

  private checkDmlWithoutWhere(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if ((plan.type === 'UPDATE' || plan.type === 'DELETE') && plan.whereConditions.length === 0) {
      issues.push({
        severity: 'critical',
        message: `${plan.type} senza WHERE: modifica l'intera tabella`,
        suggestion: 'Operazione distruttiva su tutte le righe. Aggiungere una clausola WHERE o eseguirla in transazione con verifica preventiva (SELECT con lo stesso filtro).',
        code: 'DML_NO_WHERE',
      });
    }
  }

  private checkCrossJoin(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    const hasCommaJoin = /FROM\s+\w+(\s+\w+)?\s*,\s*\w+/i.test(plan.rawQuery);
    const hasCross = plan.tables.some((t) => t.joinType === 'CROSS');
    const hasJoinWithoutOn = plan.tables.some((t) => t.joinType && !t.joinCondition);
    if (hasCommaJoin || hasCross || hasJoinWithoutOn) {
      issues.push({
        severity: 'critical',
        message: 'Prodotto cartesiano rilevato (CROSS JOIN o join senza ON)',
        suggestion: 'Ogni riga viene combinata con tutte le altre: crescita quadratica. Aggiungere la condizione ON o il filtro di join mancante.',
        code: 'CROSS_JOIN',
      });
    }
  }

  private checkUnionAll(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.hasUnion && !/\bUNION\s+ALL\b/i.test(plan.rawQuery)) {
      issues.push({
        severity: 'info',
        message: 'UNION senza ALL: deduplica implicita costosa',
        suggestion: 'UNION (senza ALL) esegue un DISTINCT su tutto il risultato. Se le righe sono già distinte, usare UNION ALL.',
        code: 'UNION_ALL',
      });
    }
  }

  private validateSchema(plan: SqlQueryPlan, schema: SchemaInfo, issues: PerformanceIssue[]): void {
    const knownTables = new Set<string>();
    for (const t of plan.tables) {
      const entry = schema.tables[t.name.toLowerCase()];
      if (!entry) {
        issues.push({
          severity: 'warning',
          message: `Tabella "${t.name}" non trovata nello schema noto`,
          suggestion:
            'Verificare il nome della tabella. Se esiste, aggiungere il suo CREATE TABLE al file di schema (impostazione vs-sqlview.schemaFile) o nello stesso file.',
          code: 'UNKNOWN_TABLE',
        });
      } else {
        knownTables.add(t.name.toLowerCase());
        if (t.alias) knownTables.add(t.alias.toLowerCase());
      }
    }

    const aliasMap = this.buildAliasMap(plan);
    for (const col of plan.columns) {
      if (!col.name || col.name === '*' || /[\s()]/.test(col.name)) continue;
      const candidates: string[] = [];
      if (col.table) {
        const resolved = this.resolveTable(col.table, aliasMap);
        if (resolved) candidates.push(resolved.toLowerCase());
      } else {
        for (const t of plan.tables) {
          if (schema.tables[t.name.toLowerCase()]) candidates.push(t.name.toLowerCase());
        }
      }
      if (candidates.length === 0) continue;
      const found = candidates.some((t) =>
        (schema.tables[t]?.columns ?? []).map((c) => c.toLowerCase()).includes(col.name.toLowerCase())
      );
      if (!found) {
        const where = col.table ? ` (tabella ${col.table})` : '';
        issues.push({
          severity: 'warning',
          message: `Colonna "${col.name}"${where} non trovata nello schema noto`,
          suggestion: 'Verificare il nome della colonna: potrebbe essere un refuso oppure mancare nel file di schema.',
          code: 'UNKNOWN_COLUMN',
        });
      }
    }
  }

  private checkInsertWithoutColumns(plan: SqlQueryPlan, issues: PerformanceIssue[]): void {
    if (plan.type === 'INSERT' && /\bINSERT\s+INTO\s+\w+\s+VALUES\b/i.test(plan.rawQuery)) {
      issues.push({
        severity: 'info',
        message: 'INSERT senza lista colonne',
        suggestion: 'Specificare le colonne (INSERT INTO t (a, b) ...) per robustezza contro cambi di schema.',
        code: 'INSERT_NO_COLS',
      });
    }
  }
}

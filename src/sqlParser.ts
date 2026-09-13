export interface SqlTable {
  name: string;
  alias?: string;
  joinType?: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
  joinCondition?: string;
}

export interface SqlColumn {
  name: string;
  table?: string;
  alias?: string;
  isAggregate?: boolean;
}

export interface SqlQueryPlan {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'UNKNOWN';
  tables: SqlTable[];
  columns: SqlColumn[];
  whereConditions: string[];
  groupByColumns: string[];
  havingConditions: string[];
  orderByColumns: string[];
  hasSubquery: boolean;
  hasUnion: boolean;
  limit?: number;
  offset?: number;
  ctes?: string[];
  rawQuery: string;
}

export interface SqlStatement {
  text: string;
  start: number;
  end: number;
}

/** Divide un documento SQL in singoli statement su `;`, rispettando stringhe, commenti e parentesi. */
export function splitStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  let str: string | null = null;
  let lineComment = false;
  let blockComment = false;

  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (raw.replace(/;/g, '').trim().length > 0) {
      out.push({ text: raw, start, end });
    }
  };

  while (i < sql.length) {
    const ch = sql[i];
    const nxt = i + 1 < sql.length ? sql[i + 1] : '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && nxt === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (str) {
      if (ch === str) {
        if (nxt === str) {
          i += 2;
          continue;
        }
        str = null;
      }
      i++;
      continue;
    }
    if (ch === '-' && nxt === '-') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && nxt === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      push(i + 1);
      start = i + 1;
    }
    i++;
  }
  push(sql.length);
  return out;
}

export class SqlParser {
  parse(sql: string): SqlQueryPlan {
    const normalized = this.normalize(sql);
    const queryType = this.detectQueryType(normalized);

    return {
      type: queryType,
      tables: this.extractTables(normalized),
      columns: this.extractColumns(normalized),
      whereConditions: this.extractWhereConditions(normalized),
      groupByColumns: this.extractGroupBy(normalized),
      havingConditions: this.extractHaving(normalized),
      orderByColumns: this.extractOrderBy(normalized),
      hasSubquery: this.detectSubquery(normalized),
      hasUnion: this.detectUnion(normalized),
      limit: this.extractLimit(normalized),
      offset: this.extractOffset(normalized),
      ctes: this.extractCTEs(normalized),
      rawQuery: sql,
    };
  }

  private normalize(sql: string): string {
    return sql
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private detectQueryType(sql: string): SqlQueryPlan['type'] {
    const upper = sql.toUpperCase();
    if (upper.startsWith('WITH') && upper.includes('SELECT')) return 'SELECT';
    if (upper.startsWith('SELECT')) return 'SELECT';
    if (upper.startsWith('INSERT')) return 'INSERT';
    if (upper.startsWith('UPDATE')) return 'UPDATE';
    if (upper.startsWith('DELETE')) return 'DELETE';
    if (upper.startsWith('MERGE')) return 'MERGE';
    return 'UNKNOWN';
  }

  private extractCTEs(sql: string): string[] {
    const ctes: string[] = [];
    const withMatch = sql.match(/\bWITH\s+([\s\S]+?)\bSELECT\b/i);
    if (!withMatch) return ctes;

    const cteList = withMatch[1].split(/,(?![^(]*\))/);
    for (const c of cteList) {
      const nameMatch = c.trim().match(/^(\w+)\s+AS/i);
      if (nameMatch) {
        ctes.push(nameMatch[1]);
      }
    }
    return ctes;
  }

  private extractTables(sql: string): SqlTable[] {
    const tables: SqlTable[] = [];
    // Le parole riservate non possono essere alias: senza questo guard l'alias
    // opzionale mangia keyword (WHERE, ON...) e il match fallisce senza backtrack utile.
    const RESERVED =
      'WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|ON|USING|AND|OR|SELECT|FROM';
    const aliasPart = `(?:\\s+(?:AS\\s+)?((?!(?:${RESERVED})\\b)\\w+))?`;

    // Extract JOINs with condition (il tipo di join è opzionale: JOIN nudo = INNER)
    const joinRegex = new RegExp(
      `(?:\\b(INNER|LEFT\\s+OUTER|RIGHT\\s+OUTER|FULL\\s+OUTER|LEFT|RIGHT|FULL|CROSS)\\s+)?\\bJOIN\\s+(\\w+)${aliasPart}(?:\\s+ON\\s+([\\s\\S]+?))?(?=\\s*(?:\\b(INNER|LEFT|RIGHT|FULL|CROSS|JOIN|USING|WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|UNION|ON)\\b|[;)$]))`,
      'gi'
    );
    let match;
    while ((match = joinRegex.exec(sql)) !== null) {
      const rawType = match[1] ? match[1].toUpperCase().replace(/\s+OUTER/, '') : 'INNER';
      tables.push({
        name: match[2],
        alias: match[3] && !['ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'UNION'].includes(match[3].toUpperCase()) ? match[3] : undefined,
        joinType: rawType as SqlTable['joinType'],
        joinCondition: match[4] ? match[4].trim() : undefined,
      });
    }

    // Extract initial FROM table
    const fromRegex = new RegExp(`\\bFROM\\s+(\\w+)${aliasPart}`, 'i');
    const fromMatch = sql.match(fromRegex);
    if (fromMatch) {
      tables.unshift({
        name: fromMatch[1],
        alias: fromMatch[2] && !['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'ON'].includes(fromMatch[2].toUpperCase()) ? fromMatch[2] : undefined,
      });
    }

    return tables;
  }

  private extractColumns(sql: string): SqlColumn[] {
    const columns: SqlColumn[] = [];

    const selectRegex = /\bSELECT\s+(?:DISTINCT\s+)?([\s\S]+?)(?=\s+FROM\b)/i;
    const selectMatch = sql.match(selectRegex);
    if (!selectMatch) return columns;

    const selectPart = selectMatch[1];
    const columnList = this.splitByComma(selectPart);

    for (const col of columnList) {
      const trimmed = col.trim();
      if (!trimmed) continue;
      const upperTrimmed = trimmed.toUpperCase();

      if (upperTrimmed === '*') {
        columns.push({ name: '*', isAggregate: false });
        continue;
      }

      const aliasMatch = trimmed.match(/^([\s\S]+?)\s+(?:AS\s+)?(\w+)$/i);
      if (aliasMatch && !aliasMatch[1].toUpperCase().endsWith('CASE')) {
        const colDef = aliasMatch[1].trim();
        const alias = aliasMatch[2].trim();
        const isAgg = this.isAggregateFunction(colDef);
        const dotMatch = colDef.match(/^(\w+)\.(\w+)$/);
        columns.push({
          name: dotMatch ? dotMatch[2] : colDef,
          table: dotMatch ? dotMatch[1] : undefined,
          alias,
          isAggregate: isAgg,
        });
      } else {
        const isAgg = this.isAggregateFunction(trimmed);
        const dotMatch = trimmed.match(/^(\w+)\.(\w+)$/);
        columns.push({
          name: dotMatch ? dotMatch[2] : trimmed,
          table: dotMatch ? dotMatch[1] : undefined,
          isAggregate: isAgg,
        });
      }
    }

    return columns;
  }

  private isAggregateFunction(expr: string): boolean {
    const upper = expr.toUpperCase();
    return /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|ARRAY_AGG|STRING_AGG)\s*\(/.test(upper);
  }

  private splitByComma(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
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

  private extractWhereConditions(sql: string): string[] {
    const conditions: string[] = [];
    const whereRegex = /\bWHERE\s+([\s\S]+?)(?=\s+GROUP\s+BY\b|\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i;
    const whereMatch = sql.match(whereRegex);
    if (!whereMatch) return conditions;

    const wherePart = whereMatch[1];
    const parts = this.splitByLogicalOperators(wherePart);
    for (const p of parts) {
      if (p.trim()) conditions.push(p.trim());
    }

    return conditions;
  }

  private extractHaving(sql: string): string[] {
    const conditions: string[] = [];
    const havingRegex = /\bHAVING\s+([\s\S]+?)(?=\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i;
    const havingMatch = sql.match(havingRegex);
    if (!havingMatch) return conditions;

    const havingPart = havingMatch[1];
    const parts = this.splitByLogicalOperators(havingPart);
    for (const p of parts) {
      if (p.trim()) conditions.push(p.trim());
    }

    return conditions;
  }

  private splitByLogicalOperators(s: string): string[] {
    const parts: string[] = [];
    let current = '';
    const upper = s.toUpperCase();

    let i = 0;
    let depth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;

      const remaining = upper.substring(i);
      if (depth === 0 && (remaining.startsWith(' AND ') || remaining.startsWith(' OR '))) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += remaining.startsWith(' AND ') ? 5 : 4;
      } else {
        current += s[i];
        i++;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  private extractGroupBy(sql: string): string[] {
    const groupByRegex = /\bGROUP\s+BY\s+([\s\S]+?)(?=\s+HAVING\b|\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i;
    const match = sql.match(groupByRegex);
    if (!match) return [];
    return match[1].split(',').map((c) => c.trim());
  }

  private extractOrderBy(sql: string): string[] {
    const withoutOver = sql.replace(/\bOVER\s*\([^()]*\)/gi, 'OVER (...)');
    const orderByRegex = /\bORDER\s+BY\s+([\s\S]+?)(?=\s+LIMIT\b|$)/i;
    const match = withoutOver.match(orderByRegex);
    if (!match) return [];
    return match[1].split(',').map((c) => c.trim());
  }

  private detectSubquery(sql: string): boolean {
    return /\bSELECT\b.*\bFROM\b/i.test(sql) && /\(\s*\bSELECT\b/i.test(sql);
  }

  private detectUnion(sql: string): boolean {
    return /\bUNION\b/i.test(sql);
  }

  private extractLimit(sql: string): number | undefined {
    const limitRegex = /\bLIMIT\s+(\d+)/i;
    const match = sql.match(limitRegex);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private extractOffset(sql: string): number | undefined {
    const offsetRegex = /\bOFFSET\s+(\d+)/i;
    const match = sql.match(offsetRegex);
    return match ? parseInt(match[1], 10) : undefined;
  }
}

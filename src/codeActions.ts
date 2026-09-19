import * as vscode from 'vscode';
import { SqlParser, splitStatements, SqlQueryPlan } from './sqlParser';
import { PerformanceAnalyzer, IndexSuggestion } from './performanceAnalyzer';
import { parseSchema, SchemaInfo } from './schema';
import { formatSql, FormatOptions } from './sqlFormatter';

export class SqlCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite,
  ];

  private readonly parser = new SqlParser();
  private readonly analyzer = new PerformanceAnalyzer();

  public async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): Promise<vscode.CodeAction[]> {
    if (document.languageId !== 'sql') {
      return [];
    }

    const actions: vscode.CodeAction[] = [];
    const fullText = document.getText();
    const schema = await this.loadSchema(document);

    // 1. Quick Fixes basati sulle Diagnostics di vs-sqlview
    const vsDiags = context.diagnostics.filter((d) => d.source === 'vs-sqlview');
    for (const diag of vsDiags) {
      const diagCode = String(diag.code ?? '');
      const diagRange = diag.range;

      switch (diagCode) {
        case 'SELECT_STAR': {
          const action = this.createSelectStarFix(document, diagRange, fullText, schema, diag);
          if (action) actions.push(action);
          break;
        }

        case 'MISSING_LIMIT':
        case 'ORDER_BY_NO_LIMIT': {
          actions.push(...this.createLimitFixes(document, diagRange, fullText, diag));
          break;
        }

        case 'LIKE_INDEX': {
          actions.push(...this.createLikeFixes(document, diagRange, fullText, diag));
          break;
        }

        case 'UNION_ALL': {
          const action = this.createUnionAllFix(document, diagRange, diag);
          if (action) actions.push(action);
          break;
        }

        case 'DISTINCT': {
          const action = this.createDistinctFix(document, diagRange, diag);
          if (action) actions.push(action);
          break;
        }

        case 'HAVING_NO_GROUP': {
          actions.push(...this.createHavingFixes(document, diagRange, diag));
          break;
        }

        case 'DML_NO_WHERE':
        case 'MISSING_WHERE': {
          const action = this.createWhereFix(document, diagRange, fullText, diag);
          if (action) actions.push(action);
          break;
        }

        case 'CROSS_JOIN': {
          const action = this.createCrossJoinFix(document, diagRange, diag);
          if (action) actions.push(action);
          break;
        }

        case 'NOT_IN_NULL': {
          const action = this.createNotInFix(document, diagRange, diag);
          if (action) actions.push(action);
          break;
        }

        case 'INSERT_NO_COLS': {
          const action = this.createInsertColsFix(document, diagRange, fullText, schema, diag);
          if (action) actions.push(action);
          break;
        }
      }
    }

    // 2. Azioni per Indici suggeriti dallo statement corrente
    try {
      const stmts = splitStatements(fullText);
      const curStmt = stmts.find((s) => s.start <= range.start.character && s.end >= range.end.character) ||
        stmts.find((s) => range.start.line >= document.positionAt(s.start).line && range.start.line <= document.positionAt(s.end).line) ||
        (stmts.length === 1 ? stmts[0] : undefined);

      if (curStmt) {
        const plan = this.parser.parse(curStmt.text);
        const result = this.analyzer.analyzeFull(plan, schema);
        for (const idx of result.indexes) {
          const indexAction = this.createIndexSuggestionAction(document, curStmt.start, idx);
          actions.push(indexAction);
        }
      }
    } catch {
      // Ignora errori di parsing non bloccanti
    }

    // 3. Quick Action di formattazione della selezione o statement
    if (!range.isEmpty) {
      const formatAction = new vscode.CodeAction('Formatta selezione SQL', vscode.CodeActionKind.RefactorRewrite);
      const selectedText = document.getText(range);
      const cfg = vscode.workspace.getConfiguration('vs-sqlview');
      const opts: FormatOptions = {
        keywordCase: cfg.get<'upper' | 'lower' | 'preserve'>('format.keywordCase', 'upper'),
        indentWidth: cfg.get<number>('format.indentWidth', 2),
      };
      const formatted = formatSql(selectedText, opts);
      if (formatted !== selectedText) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, formatted);
        formatAction.edit = edit;
        actions.push(formatAction);
      }
    }

    return actions;
  }

  private createSelectStarFix(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    fullText: string,
    schema: SchemaInfo,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const textAtRange = document.getText(diagRange);
    if (!/SELECT/i.test(textAtRange)) return undefined;

    let replacement = '/* specificare colonne esplicite: id, col1, col2 */';
    try {
      const plan = this.parser.parse(fullText);
      const knownCols: string[] = [];

      for (const t of plan.tables) {
        const schemaTable = schema.tables[t.name.toLowerCase()];
        if (schemaTable && schemaTable.columns.length > 0) {
          for (const col of schemaTable.columns) {
            if (plan.tables.length > 1 && t.alias) {
              knownCols.push(`${t.alias}.${col}`);
            } else if (plan.tables.length > 1) {
              knownCols.push(`${t.name}.${col}`);
            } else {
              knownCols.push(col);
            }
          }
        }
      }

      if (knownCols.length > 0) {
        replacement = knownCols.join(', ');
      }
    } catch {
      // Fallback a commento
    }

    const title = replacement.startsWith('/*')
      ? 'Sostituisci "SELECT *" con placeholder colonne'
      : `Sostituisci "SELECT *" con colonne dello schema (${replacement.length > 30 ? replacement.slice(0, 27) + '...' : replacement})`;

    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diag];
    action.isPreferred = true;

    const edit = new vscode.WorkspaceEdit();
    // Trova l'asterisco nel range del diagnostic
    const starMatch = textAtRange.match(/\*/);
    if (starMatch && starMatch.index !== undefined) {
      const startPos = document.positionAt(document.offsetAt(diagRange.start) + starMatch.index);
      const endPos = document.positionAt(document.offsetAt(diagRange.start) + starMatch.index + 1);
      edit.replace(document.uri, new vscode.Range(startPos, endPos), replacement);
    } else {
      edit.replace(document.uri, diagRange, `SELECT ${replacement}`);
    }

    action.edit = edit;
    return action;
  }

  private createLimitFixes(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    fullText: string,
    diag: vscode.Diagnostic
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Trova lo statement corrente
    const docOffset = document.offsetAt(diagRange.start);
    const stmts = splitStatements(fullText);
    const stmt = stmts.find((s) => s.start <= docOffset && s.end >= docOffset) || {
      text: fullText,
      start: 0,
      end: fullText.length,
    };

    let insertOffset = stmt.end;
    const slice = fullText.slice(stmt.start, stmt.end);
    const semiMatch = slice.match(/;\s*$/);
    if (semiMatch && semiMatch.index !== undefined) {
      insertOffset = stmt.start + semiMatch.index;
    }

    const insertPos = document.positionAt(insertOffset);

    // 1. LIMIT (PostgreSQL, MySQL, SQLite)
    const limitAction = new vscode.CodeAction('Aggiungi "LIMIT 1000" (PostgreSQL, MySQL, SQLite)', vscode.CodeActionKind.QuickFix);
    limitAction.diagnostics = [diag];
    limitAction.isPreferred = true;
    const editLimit = new vscode.WorkspaceEdit();
    editLimit.insert(document.uri, insertPos, '\nLIMIT 1000');
    limitAction.edit = editLimit;
    actions.push(limitAction);

    // 2. FETCH FIRST (Standard SQL / Oracle / DB2)
    const fetchAction = new vscode.CodeAction('Aggiungi "FETCH FIRST 1000 ROWS ONLY" (ANSI SQL / Oracle)', vscode.CodeActionKind.QuickFix);
    fetchAction.diagnostics = [diag];
    const editFetch = new vscode.WorkspaceEdit();
    editFetch.insert(document.uri, insertPos, '\nFETCH FIRST 1000 ROWS ONLY');
    fetchAction.edit = editFetch;
    actions.push(fetchAction);

    // 3. TOP (SQL Server / T-SQL)
    const selectMatch = slice.match(/\bSELECT\s+(DISTINCT\s+)?/i);
    if (selectMatch && selectMatch.index !== undefined) {
      const topOffset = stmt.start + selectMatch.index + selectMatch[0].length;
      const topPos = document.positionAt(topOffset);
      const topAction = new vscode.CodeAction('Aggiungi "TOP 1000" (SQL Server / T-SQL)', vscode.CodeActionKind.QuickFix);
      topAction.diagnostics = [diag];
      const editTop = new vscode.WorkspaceEdit();
      editTop.insert(document.uri, topPos, 'TOP 1000 ');
      topAction.edit = editTop;
      actions.push(topAction);
    }

    return actions;
  }

  private createLikeFixes(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    fullText: string,
    diag: vscode.Diagnostic
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const textAtRange = document.getText(diagRange);
    const m = textAtRange.match(/LIKE\s+(['"])(%)([^'"]+)\1/i);

    if (m) {
      const quote = m[1];
      const rest = m[3];
      const action = new vscode.CodeAction(
        `Rimuovi '%' iniziale (LIKE ${quote}${rest}${quote}) per abilitare indice B-tree`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diag];
      action.isPreferred = true;

      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, diagRange, `LIKE ${quote}${rest}${quote}`);
      action.edit = edit;
      actions.push(action);
    }

    const commentAction = new vscode.CodeAction(
      'Aggiungi nota per ricerca FULLTEXT / Trigram',
      vscode.CodeActionKind.QuickFix
    );
    commentAction.diagnostics = [diag];
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      document.uri,
      new vscode.Position(diagRange.start.line, 0),
      '-- SUGGERIMENTO: Per ricerche con wildcard iniziale (%pattern%), valutare indice FULLTEXT o estensione pg_trgm.\n'
    );
    commentAction.edit = edit;
    actions.push(commentAction);

    return actions;
  }

  private createUnionAllFix(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const text = document.getText(diagRange);
    if (!/\bUNION\b/i.test(text)) return undefined;

    const action = new vscode.CodeAction('Converti in "UNION ALL"', vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diag];
    action.isPreferred = true;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, diagRange, text.replace(/\bUNION\b/i, 'UNION ALL'));
    action.edit = edit;
    return action;
  }

  private createDistinctFix(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const text = document.getText(diagRange);
    if (!/\bDISTINCT\b/i.test(text)) return undefined;

    const action = new vscode.CodeAction('Rimuovi "DISTINCT"', vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diag];
    action.isPreferred = true;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, diagRange, text.replace(/\bDISTINCT\s+/i, ''));
    action.edit = edit;
    return action;
  }

  private createHavingFixes(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    diag: vscode.Diagnostic
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const text = document.getText(diagRange);

    if (/\bHAVING\b/i.test(text)) {
      const fixToWhere = new vscode.CodeAction('Sostituisci "HAVING" con "WHERE"', vscode.CodeActionKind.QuickFix);
      fixToWhere.diagnostics = [diag];
      fixToWhere.isPreferred = true;
      const editWhere = new vscode.WorkspaceEdit();
      editWhere.replace(document.uri, diagRange, text.replace(/\bHAVING\b/i, 'WHERE'));
      fixToWhere.edit = editWhere;
      actions.push(fixToWhere);

      const addGroup = new vscode.CodeAction('Aggiungi clausola "GROUP BY"', vscode.CodeActionKind.QuickFix);
      addGroup.diagnostics = [diag];
      const editGroup = new vscode.WorkspaceEdit();
      editGroup.insert(document.uri, diagRange.start, 'GROUP BY /* specificare colonna */\n');
      addGroup.edit = editGroup;
      actions.push(addGroup);
    }

    return actions;
  }

  private createWhereFix(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    fullText: string,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const action = new vscode.CodeAction('Aggiungi clausola "WHERE"', vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diag];
    action.isPreferred = true;

    const docOffset = document.offsetAt(diagRange.start);
    const stmts = splitStatements(fullText);
    const stmt = stmts.find((s) => s.start <= docOffset && s.end >= docOffset) || {
      text: fullText,
      start: 0,
      end: fullText.length,
    };

    let insertOffset = stmt.end;
    const slice = fullText.slice(stmt.start, stmt.end);
    const semiMatch = slice.match(/;\s*$/);
    if (semiMatch && semiMatch.index !== undefined) {
      insertOffset = stmt.start + semiMatch.index;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(insertOffset), '\nWHERE id = /* specificare condizione */');
    action.edit = edit;
    return action;
  }

  private createCrossJoinFix(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const text = document.getText(diagRange);
    const action = new vscode.CodeAction(
      'Sostituisci CROSS JOIN con "INNER JOIN ... ON ..."',
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;

    const edit = new vscode.WorkspaceEdit();
    if (/CROSS\s+JOIN/i.test(text)) {
      edit.replace(document.uri, diagRange, 'INNER JOIN /* tabella */ ON /* condizione */');
    } else {
      edit.insert(document.uri, diagRange.end, '\n-- SUGGERIMENTO: Esplicitare INNER JOIN ... ON ... al posto della virgola');
    }
    action.edit = edit;
    return action;
  }

  private createNotInFix(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const action = new vscode.CodeAction(
      'Aggiungi suggerimento per riscrivere NOT IN con NOT EXISTS',
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;

    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      document.uri,
      new vscode.Position(diagRange.start.line, 0),
      '-- SUGGERIMENTO: Se la colonna contiene NULL, sostituire NOT IN con NOT EXISTS (SELECT 1 FROM ... WHERE ...)\n'
    );
    action.edit = edit;
    return action;
  }

  private createInsertColsFix(
    document: vscode.TextDocument,
    diagRange: vscode.Range,
    fullText: string,
    schema: SchemaInfo,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const m = fullText.match(/\bINSERT\s+INTO\s+(\w+)\s+VALUES\b/i);
    if (!m) return undefined;

    const tableName = m[1];
    const schemaTable = schema.tables[tableName.toLowerCase()];
    const cols = schemaTable && schemaTable.columns.length > 0
      ? ` (${schemaTable.columns.join(', ')})`
      : ' (/* specificare colonne */)';

    const action = new vscode.CodeAction(
      `Esplicita lista colonne per INSERT in ${tableName}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;

    const edit = new vscode.WorkspaceEdit();
    const insertPos = document.positionAt(document.offsetAt(diagRange.start) + `INSERT INTO ${tableName}`.length);
    edit.insert(document.uri, insertPos, cols);
    action.edit = edit;
    return action;
  }

  private createIndexSuggestionAction(
    document: vscode.TextDocument,
    stmtStart: number,
    idx: IndexSuggestion
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Suggerimento Indice: ${idx.ddl.replace(/;$/, '')}`,
      vscode.CodeActionKind.RefactorRewrite
    );
    const edit = new vscode.WorkspaceEdit();
    const pos = document.positionAt(stmtStart);
    edit.insert(document.uri, new vscode.Position(pos.line, 0), `-- Indice consigliato: ${idx.reason}\n${idx.ddl}\n\n`);
    action.edit = edit;
    return action;
  }

  private async loadSchema(document: vscode.TextDocument): Promise<SchemaInfo> {
    let ddl = document.getText();
    try {
      const configured = vscode.workspace.getConfiguration('vs-sqlview').get<string>('schemaFile', '');
      if (configured && configured.trim()) {
        let uri: vscode.Uri;
        if (configured.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(configured)) {
          uri = vscode.Uri.file(configured);
        } else {
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (folder) uri = vscode.Uri.joinPath(folder, configured);
          else return parseSchema(ddl);
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        ddl += '\n' + Buffer.from(bytes).toString('utf8');
      }
    } catch {
      // Ignora schema se non accessibile
    }
    return parseSchema(ddl);
  }
}

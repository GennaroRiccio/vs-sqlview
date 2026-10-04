declare const console: {
  log: (...data: any[]) => void;
};

import * as vscode from 'vscode';
import { SqlParser, splitStatements } from './sqlParser';
import { PerformanceAnalyzer } from './performanceAnalyzer';
import { QueryPlanPanel } from './queryPlanPanel';
import { QueryFlowPanel } from './queryFlowPanel';
import { SqlDiagnostics } from './diagnostics';
import { SqlCodeActionProvider } from './codeActions';
import { formatSql, FormatOptions } from './sqlFormatter';
import { parseSchema, mergeDbColumnTypes, SchemaInfo } from './schema';
import { hasNvarcharLiteral } from './nvarcharCheck';
import { readDbOptions, fetchDbColumnTypes, testDbConnection, clearDbSchemaCache } from './dbSchema';

const sqlParser = new SqlParser();
const performanceAnalyzer = new PerformanceAnalyzer();

interface StatementPick extends vscode.QuickPickItem {
  index: number;
}

/** Se il file contiene più statement, fa scegliere quale analizzare. */
async function pickStatementSql(document: vscode.TextDocument): Promise<string | undefined> {
  const full = document.getText();
  const stmts = splitStatements(full).filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)\b/i.test(s.text));
  if (stmts.length <= 1) return full;
  const pick = await vscode.window.showQuickPick<StatementPick>(
    stmts.map((s, i) => ({
      label: `Statement ${i + 1}`,
      description: s.text.replace(/\s+/g, ' ').trim().slice(0, 90),
      index: i,
    })),
    { placeHolder: 'Il file contiene più query: quale vuoi analizzare?' }
  );
  if (!pick) return undefined;
  return stmts[pick.index].text;
}

async function loadSchema(document: vscode.TextDocument): Promise<SchemaInfo> {
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
    // schema opzionale: si continua con quello trovato nel documento
  }
  const schema = parseSchema(ddl);
  // Arricchisce con i tipi reali dal DB (VARCHAR vs NVARCHAR) quando la connessione è abilitata
  try {
    const { enabled, options } = readDbOptions();
    if (enabled && options.server && options.database) {
      const plan = sqlParser.parse(document.getText());
      if (plan.tables.length > 0) {
        const dbTypes = await fetchDbColumnTypes(plan.tables.map((t) => t.name));
        if (Object.keys(dbTypes).length > 0) mergeDbColumnTypes(schema, dbTypes);
      }
    }
  } catch {
    // DB non raggiungibile: si continua con i tipi dal DDL locale
  }
  return schema;
}

export function activate(context: vscode.ExtensionContext) {
  console.log('VS-SQLView extension is now active!');

  const analyzeCommand = vscode.commands.registerCommand('vs-sqlview.analyzeSqlScript', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Nessun editor attivo. Apri un file SQL e riprova.');
      return;
    }
    const sql = await pickStatementSql(editor.document);
    if (!sql || !sql.trim()) return;

    try {
      const plan = sqlParser.parse(sql);
      const schema = await loadSchema(editor.document);
      const result = performanceAnalyzer.analyzeFull(plan, schema);
      const { issues, score, indexes } = result;

      QueryPlanPanel.createOrShow(context.extensionUri, plan, result);

      const criticalCount = issues.filter((i) => i.severity === 'critical').length;
      const warningCount = issues.filter((i) => i.severity === 'warning').length;
      const infoCount = issues.filter((i) => i.severity === 'info').length;

      let summary = `Analisi completata: ${plan.type} — Score ${score.total}/100 (${score.grade})`;
      if (issues.length > 0) {
        summary += ` — ${criticalCount} critici, ${warningCount} warning, ${infoCount} info`;
      } else {
        summary += ' — Nessun problema rilevato';
      }
      if (indexes.length > 0) {
        summary += ` — ${indexes.length} indici suggeriti`;
      }

      vscode.window.showInformationMessage(summary);
    } catch (error) {
      vscode.window.showErrorMessage(`Errore nell'analisi SQL: ${error}`);
    }
  });

  context.subscriptions.push(analyzeCommand);

  const flowCommand = vscode.commands.registerCommand('vs-sqlview.showQueryFlow', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Nessun editor attivo. Apri un file SQL e riprova.');
      return;
    }
    const sql = await pickStatementSql(editor.document);
    if (!sql || !sql.trim()) return;
    try {
      const plan = sqlParser.parse(sql);
      const schema = await loadSchema(editor.document);
      const result = performanceAnalyzer.analyzeFull(plan, schema);
      QueryFlowPanel.createOrShow(context.extensionUri, plan, result);
    } catch (error) {
      vscode.window.showErrorMessage(`Errore nel flow SQL: ${error}`);
    }
  });

  context.subscriptions.push(flowCommand);

  const diagnostics = new SqlDiagnostics();
  context.subscriptions.push(diagnostics);

  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    'sql',
    new SqlCodeActionProvider(),
    {
      providedCodeActionKinds: SqlCodeActionProvider.providedCodeActionKinds,
    }
  );
  context.subscriptions.push(codeActionProvider);

  const refreshActive = () => {
    const ed = vscode.window.activeTextEditor;
    if (ed) diagnostics.update(ed.document);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => diagnostics.update(d)),
    vscode.workspace.onDidChangeTextDocument((e) => diagnostics.schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((d) => diagnostics.update(d)),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.clear(d)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) diagnostics.update(ed.document);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vs-sqlview')) refreshActive();
    })
  );
  refreshActive();

  const getFormatOptions = (): FormatOptions => {
    const cfg = vscode.workspace.getConfiguration('vs-sqlview');
    return {
      keywordCase: cfg.get<FormatOptions['keywordCase']>('format.keywordCase', 'upper'),
      indentWidth: cfg.get<number>('format.indentWidth', 2),
    };
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider('sql', {
      provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
        try {
          const formatted = formatSql(document.getText(), getFormatOptions());
          if (formatted === document.getText()) return [];
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          );
          return [vscode.TextEdit.replace(fullRange, formatted)];
        } catch {
          return [];
        }
      },
    })
  );

  const formatCommand = vscode.commands.registerCommand('vs-sqlview.formatSql', () => {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === 'sql') {
      vscode.commands.executeCommand('editor.action.formatDocument');
    } else {
      vscode.window.showWarningMessage('Apri un file SQL per formattarlo.');
    }
  });
  context.subscriptions.push(formatCommand);

  const nvarcharCommand = vscode.commands.registerCommand('vs-sqlview.checkNvarchar', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Nessun editor attivo. Apri un file SQL e riprova.');
      return;
    }
    const sql = await pickStatementSql(editor.document);
    if (!sql || !sql.trim()) return;
    try {
      const plan = sqlParser.parse(sql);
      const schema = await loadSchema(editor.document);
      const result = performanceAnalyzer.analyzeFull(plan, schema);
      const nv = result.issues.filter((i) => (i.code ?? '').startsWith('NVARCHAR'));
      if (nv.length === 0) {
        vscode.window.showInformationMessage(
          hasNvarcharLiteral(sql)
            ? 'Nessuna incoerenza VARCHAR/NVARCHAR rilevata.'
            : 'Nessun letterale N\'...\' nello script: niente da verificare.'
        );
      } else {
        const lines = nv.map((i) => `• [${i.severity}] ${i.message}`).join('\n');
        vscode.window.showWarningMessage(`Coerenza VARCHAR/NVARCHAR: ${nv.length} avvisi`, { modal: false, detail: lines });
      }
      QueryPlanPanel.createOrShow(context.extensionUri, plan, result);
    } catch (error) {
      vscode.window.showErrorMessage(`Errore nel controllo NVARCHAR: ${error}`);
    }
  });
  context.subscriptions.push(nvarcharCommand);

  const testDbCommand = vscode.commands.registerCommand('vs-sqlview.testDbConnection', async () => {
    try {
      const { enabled, options } = readDbOptions();
      if (!enabled) {
        const open = await vscode.window.showWarningMessage(
          'Connessione DB disabilitata (vs-sqlview.db.enabled = false). Aprirla nelle impostazioni?',
          'Apri impostazioni'
        );
        if (open === 'Apri impostazioni') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'vs-sqlview.db');
        }
        return;
      }
      if (!options.server || !options.database) {
        vscode.window.showErrorMessage('Impostare almeno vs-sqlview.db.server e vs-sqlview.db.database.');
        return;
      }
      const label = await testDbConnection();
      vscode.window.showInformationMessage(`Connessione DB riuscita: ${label}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Connessione DB fallita: ${error}`);
    }
  });
  context.subscriptions.push(testDbCommand);

  const refreshDbCommand = vscode.commands.registerCommand('vs-sqlview.refreshDbSchema', async () => {
    clearDbSchemaCache();
    const ed = vscode.window.activeTextEditor;
    if (ed) diagnostics.update(ed.document);
    vscode.window.showInformationMessage('Cache schema DB svuotata: tipi colonna riletti al prossimo controllo.');
  });
  context.subscriptions.push(refreshDbCommand);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'vs-sqlview.analyzeSqlScript';
  statusBarItem.text = '$(database) Analyze SQL';
  statusBarItem.tooltip = 'Analizza lo script SQL corrente';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate() {}

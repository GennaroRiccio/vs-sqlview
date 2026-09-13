import * as vscode from 'vscode';
import { SqlParser } from './sqlParser';
import { PerformanceAnalyzer, PerformanceIssue } from './performanceAnalyzer';
import { parseSchema } from './schema';

const MAX_RANGES_PER_ISSUE = 8;

export class SqlDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly parser = new SqlParser();
  private readonly analyzer = new PerformanceAnalyzer();
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('vs-sqlview');
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.collection.dispose();
  }

  schedule(document: vscode.TextDocument) {
    if (this.timer) clearTimeout(this.timer);
    const delay = vscode.workspace.getConfiguration('vs-sqlview').get<number>('diagnostics.delayMs', 400);
    this.timer = setTimeout(() => this.update(document), delay);
  }

  update(document: vscode.TextDocument) {
    if (document.languageId !== 'sql') return;
    const enabled = vscode.workspace.getConfiguration('vs-sqlview').get<boolean>('diagnostics.enabled', true);
    if (!enabled) {
      this.collection.delete(document.uri);
      return;
    }
    try {
      const text = document.getText();
      if (!text.trim()) {
        this.collection.set(document.uri, []);
        return;
      }
      const plan = this.parser.parse(text);
      const issues = this.analyzer.analyzeFull(plan, parseSchema(text)).issues;
      const diags: vscode.Diagnostic[] = [];
      for (const issue of issues) {
        for (const range of this.rangesFor(document, issue)) {
          const d = new vscode.Diagnostic(
            range,
            `${issue.message}\n${issue.suggestion}`,
            this.toSeverity(issue.severity)
          );
          d.source = 'vs-sqlview';
          d.code = issue.code ?? '';
          diags.push(d);
        }
      }
      this.collection.set(document.uri, diags);
    } catch {
      // Mai rompere l'editor per un errore di analisi
    }
  }

  clear(document: vscode.TextDocument) {
    this.collection.delete(document.uri);
  }

  private toSeverity(s: PerformanceIssue['severity']): vscode.DiagnosticSeverity {
    if (s === 'critical') return vscode.DiagnosticSeverity.Error;
    if (s === 'warning') return vscode.DiagnosticSeverity.Warning;
    return vscode.DiagnosticSeverity.Information;
  }

  private matchRanges(document: vscode.TextDocument, regex: RegExp): vscode.Range[] {
    const text = document.getText();
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const ranges: vscode.Range[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && ranges.length < MAX_RANGES_PER_ISSUE) {
      ranges.push(new vscode.Range(document.positionAt(m.index), document.positionAt(m.index + m[0].length)));
      if (m[0].length === 0) re.lastIndex++;
    }
    return ranges;
  }

  private firstMatch(document: vscode.TextDocument, regex: RegExp): vscode.Range[] {
    const r = this.matchRanges(document, regex);
    return r.length > 0 ? [r[0]] : [this.fallbackRange(document)];
  }

  private fallbackRange(document: vscode.TextDocument): vscode.Range {
    const line = document.lineAt(0);
    return new vscode.Range(0, 0, 0, line.text.length);
  }

  private rangesFor(document: vscode.TextDocument, issue: PerformanceIssue): vscode.Range[] {
    const text = document.getText();
    switch (issue.code) {
      case 'SELECT_STAR':
        return this.firstMatch(document, /SELECT\s+(?:DISTINCT\s+)?\*/i);
      case 'MISSING_WHERE':
      case 'MISSING_LIMIT':
        return this.firstMatch(document, /\bSELECT\b/i);
      case 'LIKE_INDEX': {
        const r = this.matchRanges(document, /LIKE\s+('[^']*'|\S+)/gi);
        return r.length > 0 ? r : [this.fallbackRange(document)];
      }
      case 'OR_IN_WHERE':
      case 'OR_CONDITION': {
        const r = this.matchRanges(document, /\bOR\b/gi);
        return r.length > 0 ? r : [this.fallbackRange(document)];
      }
      case 'FUNCTION_ON_WHERE': {
        const m = text.match(/\b\w+\s*\([^)]*\)\s*(=|<>|!=|<|>|<=|>=|LIKE\b)/i);
        if (m && m.index !== undefined) {
          return [new vscode.Range(document.positionAt(m.index), document.positionAt(m.index + m[0].length))];
        }
        return [this.fallbackRange(document)];
      }
      case 'FUNCTION_ON_COLUMN': {
        const r = this.matchRanges(document, /\b[A-Z_]+\s*\([^)]*\)/g);
        return r.length > 0 ? r.slice(0, 3) : [this.fallbackRange(document)];
      }
      case 'SUBQUERY':
      case 'SCALAR_SUBQUERY': {
        const r = this.matchRanges(document, /\(\s*SELECT/gi);
        return r.length > 0 ? r : [this.fallbackRange(document)];
      }
      case 'ORDER_BY_NO_LIMIT':
        return this.firstMatch(document, /\bORDER\s+BY\b/i);
      case 'MANY_JOINS': {
        const r = this.matchRanges(document, /\bJOIN\b/gi);
        return r.length > 0 ? r : [this.fallbackRange(document)];
      }
      case 'DISTINCT':
        return this.firstMatch(document, /\bDISTINCT\b/i);
      case 'NOT_IN_NULL': {
        const r = this.matchRanges(document, /\bNOT\s+IN\s*\(/gi);
        return r.length > 0 ? r : [this.fallbackRange(document)];
      }
      case 'HAVING_NO_GROUP':
        return this.firstMatch(document, /\bHAVING\b/i);
      case 'DML_NO_WHERE':
        return this.firstMatch(document, /\b(UPDATE|DELETE)\b/i);
      case 'CROSS_JOIN': {
        const r = this.matchRanges(document, /\bCROSS\s+JOIN\b/gi);
        if (r.length > 0) return r;
        const comma = text.match(/FROM\s+\w+[^\n;]*,/i);
        if (comma && comma.index !== undefined) {
          const start = document.positionAt(comma.index);
          return [new vscode.Range(start, start.translate(0, comma[0].length))];
        }
        return [this.fallbackRange(document)];
      }
      case 'UNION_ALL': {
        const r = this.matchRanges(document, /\bUNION\b(?!\s+ALL)/gi);
        return r.length > 0 ? r : [this.fallbackRange(document)];
      }
      case 'INSERT_NO_COLS':
        return this.firstMatch(document, /\bINSERT\s+INTO\b/i);
      case 'UNKNOWN_TABLE':
      case 'UNKNOWN_COLUMN': {
        const m = issue.message.match(/"(.*?)"/);
        if (m) {
          const esc = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const r = this.matchRanges(document, new RegExp(`\\b${esc}\\b`, 'gi'));
          if (r.length > 0) return r;
        }
        return [this.fallbackRange(document)];
      }
      default:
        return [this.fallbackRange(document)];
    }
  }
}

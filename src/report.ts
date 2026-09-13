import { SqlQueryPlan } from './sqlParser';
import { AnalysisResult } from './performanceAnalyzer';

export function buildMarkdownReport(plan: SqlQueryPlan, result: AnalysisResult): string {
  const { issues, indexes, score } = result;
  const lines: string[] = [];

  lines.push('# VS-SQLView — SQL Analysis Report');
  lines.push('');
  lines.push(`_Generato il ${new Date().toLocaleString('it-IT')} · Tipo: ${plan.type}_`);
  lines.push('');
  lines.push('## Query');
  lines.push('');
  lines.push('```sql');
  lines.push(plan.rawQuery.trim());
  lines.push('```');
  lines.push('');
  lines.push(`## Score: ${score.total}/100 (${score.grade})`);
  lines.push('');
  lines.push('| Categoria | Score |');
  lines.push('|---|---|');
  for (const c of score.categories) {
    lines.push(`| ${c.name} | ${c.score} |`);
  }
  lines.push('');
  lines.push(`## Problemi rilevati (${issues.length})`);
  lines.push('');
  if (issues.length === 0) {
    lines.push('Nessun problema di performance rilevato. ✅');
  } else {
    lines.push('| Severità | Problema | Suggerimento |');
    lines.push('|---|---|---|');
    for (const i of issues) {
      const sev = i.severity === 'critical' ? '🔴 critical' : i.severity === 'warning' ? '🟡 warning' : '🔵 info';
      lines.push(`| ${sev} | ${oneLine(i.message)} | ${oneLine(i.suggestion)} |`);
    }
  }
  lines.push('');
  lines.push(`## Indici suggeriti (${indexes.length})`);
  lines.push('');
  if (indexes.length === 0) {
    lines.push('Nessun indice da suggerire.');
  } else {
    for (const s of indexes) {
      lines.push(`- **${s.table}(${s.columns.join(', ')})** — ${s.reason}`);
      lines.push('');
      lines.push('  ```sql');
      lines.push(`  ${s.ddl}`);
      lines.push('  ```');
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('_Report generato da VS-SQLView_');
  lines.push('');

  return lines.join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

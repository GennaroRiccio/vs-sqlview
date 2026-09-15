import * as vscode from 'vscode';
import { SqlQueryPlan } from './sqlParser';
import { AnalysisResult, QueryScore, IndexSuggestion } from './performanceAnalyzer';
import { buildMarkdownReport } from './report';

interface QueryPlanNode {
  id: string;
  label: string;
  type: 'table' | 'filter' | 'join' | 'sort' | 'aggregate' | 'project' | 'limit' | 'subquery';
  cost: number;
  children: QueryPlanNode[];
}

export class QueryPlanPanel {
  private static currentPanel: QueryPlanPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _lastPlan: SqlQueryPlan | undefined;
  private _lastResult: AnalysisResult | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'exportPng' && typeof msg.dataUrl === 'string') {
          await this.savePng(msg.dataUrl, 'vs-sqlview-plan.png');
        } else if (msg.type === 'exportMarkdown') {
          await this.saveMarkdown();
        }
      },
      null,
      this._disposables
    );
    void extensionUri;
  }

  static createOrShow(extensionUri: vscode.Uri, plan: SqlQueryPlan, result: AnalysisResult) {
    const column = vscode.ViewColumn.Beside;

    if (QueryPlanPanel.currentPanel) {
      QueryPlanPanel.currentPanel._panel.reveal(column);
      QueryPlanPanel.currentPanel._update(plan, result);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'queryPlan',
      'SQL Query Plan',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    QueryPlanPanel.currentPanel = new QueryPlanPanel(panel, extensionUri);
    QueryPlanPanel.currentPanel._update(plan, result);
  }

  dispose() {
    QueryPlanPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) disposable.dispose();
    }
  }

  private _update(plan: SqlQueryPlan, result: AnalysisResult) {
    this._lastPlan = plan;
    this._lastResult = result;
    this._panel.webview.html = this._getHtml(plan, result);
  }

  private async savePng(dataUrl: string, defaultName: string) {
    try {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: { Immagini: ['png'] },
        saveLabel: 'Salva PNG',
      });
      if (!uri) return;
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, 'base64'));
      vscode.window.showInformationMessage(`Grafo salvato in ${uri.fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Export PNG fallito: ${error}`);
    }
  }

  private async saveMarkdown() {
    try {
      if (!this._lastPlan || !this._lastResult) {
        vscode.window.showWarningMessage('Nessuna analisi da esportare.');
        return;
      }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('vs-sqlview-report.md'),
        filters: { Markdown: ['md'] },
        saveLabel: 'Salva report',
      });
      if (!uri) return;
      const md = buildMarkdownReport(this._lastPlan, this._lastResult);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
      vscode.window.showInformationMessage(`Report salvato in ${uri.fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Export report fallito: ${error}`);
    }
  }

  private _buildPlanTree(plan: SqlQueryPlan): QueryPlanNode {
    const nodes: QueryPlanNode[] = [];

    for (const table of plan.tables) {
      const tableNode: QueryPlanNode = {
        id: `table_${table.name}`,
        label: table.name + (table.alias ? ` (${table.alias})` : ''),
        type: 'table',
        cost: 10,
        children: [],
      };

      if (table.joinType) {
        const joinNode: QueryPlanNode = {
          id: `join_${table.name}`,
          label: `${table.joinType} JOIN`,
          type: 'join',
          cost: 20,
          children: [tableNode],
        };
        nodes.push(joinNode);
      } else {
        nodes.push(tableNode);
      }
    }

    const whereNode: QueryPlanNode = {
      id: 'where',
      label: `Filter (WHERE)`,
      type: 'filter',
      cost: 15,
      children: nodes.length > 0 ? nodes : [],
    };

    const hasAgg = plan.groupByColumns.length > 0 || plan.columns.some((c) => c.isAggregate);
    const aggNode: QueryPlanNode = hasAgg
      ? {
          id: 'aggregate',
          label: `Aggregate (GROUP BY)`,
          type: 'aggregate',
          cost: 25,
          children: [whereNode],
        }
      : whereNode;

    const hasOrder = plan.orderByColumns.length > 0;
    const sortNode: QueryPlanNode = hasOrder
      ? {
          id: 'sort',
          label: `Sort (ORDER BY)`,
          type: 'sort',
          cost: 20,
          children: [aggNode],
        }
      : aggNode;

    const hasLimit = plan.limit !== undefined;
    const limitNode: QueryPlanNode = hasLimit
      ? {
          id: 'limit',
          label: `Limit (${plan.limit})`,
          type: 'limit',
          cost: 5,
          children: [sortNode],
        }
      : sortNode;

    const root: QueryPlanNode = {
      id: 'root',
      label: 'Result',
      type: 'project',
      cost: 0,
      children: [limitNode],
    };

    return root;
  }

  private _getHtml(plan: SqlQueryPlan, result: AnalysisResult): string {
    const { issues, indexes, score } = result;
    const tree = this._buildPlanTree(plan);
    const treeJson = JSON.stringify(tree);
    const planJson = JSON.stringify(plan);
    const issuesJson = JSON.stringify(issues);

    return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SQL Query Plan</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #1e1e2e;
      color: #cdd6f4;
      overflow: hidden;
      height: 100vh;
    }

    .container {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
    }

    .header {
      background: #181825;
      padding: 12px 20px;
      border-bottom: 1px solid #313244;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header h1 {
      font-size: 16px;
      color: #89b4fa;
      font-weight: 600;
    }

    .badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }

    .badge-select { background: #89b4fa22; color: #89b4fa; }
    .badge-critical { background: #f38ba822; color: #f38ba8; }
    .badge-warning { background: #fab38722; color: #fab387; }
    .badge-info { background: #a6e3a122; color: #a6e3a1; }

    .main {
      display: grid;
      grid-template-columns: 1fr 350px;
      overflow: hidden;
    }

    .canvas-area {
      position: relative;
      overflow: hidden;
    }

    canvas#flowCanvas {
      width: 100%;
      height: 100%;
      display: block;
      cursor: grab;
    }

    .zoom-controls {
      position: absolute;
      top: 10px;
      left: 10px;
      display: flex;
      gap: 6px;
      align-items: center;
      background: #181825ee;
      border: 1px solid #313244;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      color: #a6adc8;
      z-index: 5;
    }

    .zoom-controls button {
      background: #313244;
      color: #cdd6f4;
      border: 1px solid #45475a;
      border-radius: 6px;
      padding: 2px 9px;
      cursor: pointer;
      font-size: 12px;
    }

    .zoom-controls button:hover { border-color: #89b4fa; }
    #zoomLabel { min-width: 44px; text-align: center; font-weight: 600; color: #cdd6f4; }
    .zoom-hint { font-size: 10px; color: #6c7086; }

    .sidebar {
      background: #181825;
      border-left: 1px solid #313244;
      overflow-y: auto;
      padding: 16px;
    }

    .sidebar h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #a6adc8;
      margin-bottom: 12px;
    }

    .issue-card {
      background: #1e1e2e;
      border: 1px solid #313244;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 10px;
      transition: border-color 0.2s;
    }

    .issue-card:hover { border-color: #89b4fa; }
    .issue-card.critical { border-left: 3px solid #f38ba8; }
    .issue-card.warning { border-left: 3px solid #fab387; }
    .issue-card.info { border-left: 3px solid #a6e3a1; }

    .issue-card .severity {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .issue-card.critical .severity { color: #f38ba8; }
    .issue-card.warning .severity { color: #fab387; }
    .issue-card.info .severity { color: #a6e3a1; }

    .issue-card .message {
      font-size: 13px;
      font-weight: 600;
      color: #cdd6f4;
      margin-bottom: 6px;
    }

    .issue-card .suggestion {
      font-size: 12px;
      color: #a6adc8;
      line-height: 1.4;
    }

    .footer {
      background: #181825;
      padding: 8px 20px;
      border-top: 1px solid #313244;
      font-size: 11px;
      color: #6c7086;
      display: flex;
      justify-content: space-between;
    }

    .legend {
      display: flex;
      gap: 16px;
      align-items: center;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .no-issues {
      text-align: center;
      padding: 40px 20px;
      color: #6c7086;
    }

    .no-issues .icon {
      font-size: 32px;
      margin-bottom: 8px;
    }

    .cat-row { display: flex; justify-content: space-between; font-size: 12px; color: #cdd6f4; margin-top: 6px; }
    .cat-bar { background: #313244; border-radius: 4px; height: 6px; margin-top: 3px; overflow: hidden; }
    .cat-fill { height: 100%; border-radius: 4px; }
    .cat-fill.badge-a { background: #a6e3a1; }
    .cat-fill.badge-b { background: #94e2d5; }
    .cat-fill.badge-c { background: #f9e2af; }
    .cat-fill.badge-d { background: #fab387; }
    .cat-fill.badge-f { background: #f38ba8; }
    .badge-a { background: #a6e3a122; color: #a6e3a1; }
    .badge-b { background: #94e2d522; color: #94e2d5; }
    .badge-c { background: #f9e2af22; color: #f9e2af; }
    .badge-d { background: #fab38722; color: #fab387; }
    .badge-f { background: #f38ba822; color: #f38ba8; }
    .index-card { background: #1e1e2e; border: 1px solid #313244; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
    .index-card .index-reason { font-size: 12px; color: #a6adc8; margin-bottom: 6px; }
    .index-card code { display: block; font-size: 11px; color: #94e2d5; background: #11111b; border-radius: 4px; padding: 6px; white-space: pre-wrap; word-break: break-all; }
    .index-card button { margin-top: 6px; background: #313244; color: #cdd6f4; border: 1px solid #45475a; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 11px; }
    .index-card button:hover { border-color: #94e2d5; }
    .hint { font-size: 12px; color: #6c7086; }
    .export-btn { background: #313244; color: #cdd6f4; border: 1px solid #45475a; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 11px; }
    .export-btn:hover { border-color: #89b4fa; }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #313244; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>SQL Query Plan Analyzer</h1>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="export-btn" id="pngBtn" title="Salva il grafo come PNG">📷 PNG</button>
        <button class="export-btn" id="mdBtn" title="Salva il report come Markdown">📝 Report</button>
        <span class="badge badge-select">${plan.type}</span>
        <span class="badge ${this._scoreBadgeClass(score)}">Score ${score.total} · ${score.grade}</span>
        ${issues.filter((i) => i.severity === 'critical').length > 0 ? '<span class="badge badge-critical">CRITICAL</span>' : ''}
        ${issues.filter((i) => i.severity === 'warning').length > 0 ? '<span class="badge badge-warning">WARNINGS</span>' : ''}
      </div>
    </div>

    <div class="main">
      <div class="canvas-area">
        <canvas id="flowCanvas"></canvas>
        <div class="zoom-controls">
          <button id="zoomOut" title="Riduci zoom">−</button>
          <span id="zoomLabel">100%</span>
          <button id="zoomIn" title="Aumenta zoom">+</button>
          <button id="zoomReset" title="Adatta il grafo alla vista">Reset</button>
          <span class="zoom-hint">rotella = zoom · trascina = pan</span>
        </div>
      </div>
      <div class="sidebar">
        <h2>Query Score — ${score.total}/100 (${score.grade})</h2>
        <div id="scoreBox">
          ${score.categories
            .map(
              (c) => `
          <div class="cat-row"><span>${c.name}</span><span>${c.score}</span></div>
          <div class="cat-bar"><div class="cat-fill ${this._scoreBadgeClass({ total: c.score } as QueryScore)}" style="width:${c.score}%"></div></div>`
            )
            .join('')}
        </div>
        <h2 style="margin-top:14px">Indici suggeriti (${indexes.length})</h2>
        <div id="indexList">
          ${indexes.length === 0
            ? '<div class="hint">Nessun indice da suggerire.</div>'
            : indexes
                .map(
                  (s, i) => `
            <div class="index-card">
              <div class="index-reason">${this._escapeHtml(s.reason)}</div>
              <code id="ddl-${i}">${this._escapeHtml(s.ddl)}</code>
              <button onclick="copyDdl(${i})">📋 Copia DDL</button>
            </div>`
                )
                .join('')}
        </div>
        <h2 style="margin-top:14px">Performance Issues (${issues.length})</h2>
        <div id="issuesList">
          ${issues.length === 0
            ? '<div class="no-issues"><div class="icon">✅</div>Nessun problema di performance rilevato</div>'
            : issues
                .map(
                  (issue) => `
            <div class="issue-card ${issue.severity}">
              <div class="severity">${issue.severity}</div>
              <div class="message">${this._escapeHtml(issue.message)}</div>
              <div class="suggestion">${this._escapeHtml(issue.suggestion)}</div>
            </div>`
                )
                .join('')}
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="legend">
        <span style="color:#a6adc8;font-weight:600">Legenda:</span>
        <div class="legend-item"><div class="legend-dot" style="background:#89b4fa"></div>Tabella</div>
        <div class="legend-item"><div class="legend-dot" style="background:#cba6f7"></div>JOIN</div>
        <div class="legend-item"><div class="legend-dot" style="background:#fab387"></div>Filtro</div>
        <div class="legend-item"><div class="legend-dot" style="background:#f38ba8"></div>Sort</div>
        <div class="legend-item"><div class="legend-dot" style="background:#a6e3a1"></div>Aggregate</div>
        <div class="legend-item"><div class="legend-dot" style="background:#94e2d5"></div>Result</div>
      </div>
      <span>VS-SQLView v0.0.1</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('pngBtn').onclick = () => {
      const c = document.getElementById('flowCanvas');
      vscode.postMessage({ type: 'exportPng', dataUrl: c.toDataURL('image/png') });
    };
    document.getElementById('mdBtn').onclick = () => {
      vscode.postMessage({ type: 'exportMarkdown' });
    };

    const treeData = ${treeJson};
    const planData = ${planJson};

    const canvas = document.getElementById('flowCanvas');
    const ctx = canvas.getContext('2d');
    let width, height;
    let animationFrame;
    let time = 0;
    let view = { s: 1, ox: 0, oy: 0 };
    let userZoomed = false;

    function toScreen(x, y) { return [x * view.s + view.ox, y * view.s + view.oy]; }
    function updateZoomLabel() {
      const el = document.getElementById('zoomLabel');
      if (el) el.textContent = Math.round(view.s * 100) + '%';
    }

    const NODE_COLORS = {
      table:    { bg: '#89b4fa', text: '#1e1e2e' },
      join:     { bg: '#cba6f7', text: '#1e1e2e' },
      filter:   { bg: '#fab387', text: '#1e1e2e' },
      sort:     { bg: '#f38ba8', text: '#1e1e2e' },
      aggregate:{ bg: '#a6e3a1', text: '#1e1e2e' },
      project:  { bg: '#94e2d5', text: '#1e1e2e' },
      limit:    { bg: '#f9e2af', text: '#1e1e2e' },
      subquery: { bg: '#74c7ec', text: '#1e1e2e' },
    };

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function layoutTree(node, depth = 0) {
      if (!node) return { width: 0, height: 0 };
      node._depth = depth;
      if (!node.children || node.children.length === 0) {
        node._w = 140;
        node._h = 70;
        return node;
      }
      let totalW = 0;
      for (const child of node.children) {
        layoutTree(child, depth + 1);
        totalW += child._w + 24;
      }
      totalW -= 24;
      node._w = Math.max(140, totalW);
      node._h = 70;
      return node;
    }

    function positionTree(node, x, y) {
      node._x = x;
      node._y = y;
      if (!node.children || node.children.length === 0) return;

      let totalChildW = 0;
      for (const child of node.children) {
        totalChildW += child._w + 24;
      }
      totalChildW -= 24;

      let cx = x - totalChildW / 2;
      for (const child of node.children) {
        const childX = cx + child._w / 2;
        positionTree(child, childX, y + 110);
        cx += child._w + 24;
      }
    }

    function getNodeColor(type) {
      return NODE_COLORS[type] || NODE_COLORS.table;
    }

    function drawEdge(parent, child, t) {
      const p1 = toScreen(parent._x, parent._y + 35);
      const p2 = toScreen(child._x, child._y - 35);
      const x1 = p1[0];
      const y1 = p1[1];
      const x2 = p2[0];
      const y2 = p2[1];

      ctx.beginPath();
      ctx.strokeStyle = '#45475a';
      ctx.lineWidth = 2;
      ctx.moveTo(x1, y1);
      const midY = (y1 + y2) / 2;
      ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
      ctx.stroke();

      const progress = (t * 0.003) % 1;
      const px = Math.pow(1 - progress, 3) * x1 + 3 * Math.pow(1 - progress, 2) * progress * x1 + 3 * (1 - progress) * progress * progress * x2 + progress * progress * progress * x2;
      const py = Math.pow(1 - progress, 3) * y1 + 3 * Math.pow(1 - progress, 2) * progress * midY + 3 * (1 - progress) * progress * progress * midY + progress * progress * progress * y2;

      ctx.beginPath();
      ctx.fillStyle = getNodeColor(child.type).bg;
      ctx.shadowColor = getNodeColor(child.type).bg;
      ctx.shadowBlur = 10;
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (child.children) {
        for (const grandchild of child.children) {
          drawEdge(child, grandchild, t);
        }
      }
    }

    function drawNode(node) {
      const colors = getNodeColor(node.type);
      const p = toScreen(node._x, node._y);
      const cx = p[0];
      const cy = p[1];
      const w = 140 * view.s;
      const h = 70 * view.s;
      const x = cx - w / 2;
      const y = cy - h / 2;

      ctx.shadowColor = colors.bg;
      ctx.shadowBlur = 15;

      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 12); else ctx.rect(x, y, w, h);
      ctx.fillStyle = '#1e1e2e';
      ctx.fill();
      ctx.strokeStyle = colors.bg;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = colors.bg;
      ctx.font = 'bold ' + Math.max(9, Math.round(11 * view.s)) + 'px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText(node.label.length > 18 ? node.label.substring(0, 16) + '...' : node.label, cx, cy - 5 * view.s);

      ctx.fillStyle = '#a6adc8';
      ctx.font = Math.max(8, Math.round(10 * view.s)) + 'px Segoe UI';
      ctx.fillText(node.type.toUpperCase(), cx, cy + 12 * view.s);

      ctx.fillStyle = colors.bg;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 12); else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (node.children) {
        for (const child of node.children) {
          drawNode(child);
        }
      }
    }

    function fitView() {
      const pad = 40;
      const treeW = Math.max(treeData._w || 140, 1);
      const depth = getMaxDepth(treeData);
      const treeH = (depth + 1) * 110 + 40;
      const s = Math.min((width - pad * 2) / treeW, (height - pad * 2) / treeH, 1);
      view = { s: Math.max(0.4, Math.min(2.2, s || 1)), ox: 0, oy: 0 };
      userZoomed = false;
      updateZoomLabel();
    }

    function zoomAt(mx, my, factor) {
      const wx = (mx - view.ox) / view.s;
      const wy = (my - view.oy) / view.s;
      const ns = Math.min(2.2, Math.max(0.4, view.s * factor));
      view.s = ns;
      view.ox = mx - wx * ns;
      view.oy = my - wy * ns;
      userZoomed = true;
      updateZoomLabel();
    }

    let initialFitDone = false;

    function draw() {
      ctx.clearRect(0, 0, width, height);

      const startX = width / 2;
      const startY = 70;

      layoutTree(treeData);
      positionTree(treeData, startX, startY);
      if (!initialFitDone) { fitView(); initialFitDone = true; }

      drawEdge(treeData, treeData.children[0], time);
      if (treeData.children[0].children) {
        for (const child of treeData.children[0].children) {
          drawEdge(treeData.children[0], child, time);
        }
      }

      drawNode(treeData);

      time++;
      animationFrame = requestAnimationFrame(draw);
    }

    function getMaxDepth(node) {
      if (!node.children || node.children.length === 0) return 0;
      return 1 + Math.max(...node.children.map(getMaxDepth));
    }

    function copyDdl(i) {
      const el = document.getElementById('ddl-' + i);
      const text = el ? el.textContent : '';
      const done = (btn) => { if (btn) { btn.textContent = '✅ Copiato'; setTimeout(() => btn.textContent = '📋 Copia DDL', 1500); } };
      const btn = document.querySelectorAll('.index-card button')[i];
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(btn), () => done(btn));
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done(btn);
      }
    }

    window.addEventListener('resize', () => {
      resize();
    });

    document.getElementById('zoomIn').onclick = () => zoomAt(width / 2, height / 2, 1.2);
    document.getElementById('zoomOut').onclick = () => zoomAt(width / 2, height / 2, 1 / 1.2);
    document.getElementById('zoomReset').onclick = () => { fitView(); };

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });

    let drag = null;
    canvas.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX - view.ox, y: e.clientY - view.oy };
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', () => { drag = null; canvas.style.cursor = 'grab'; });
    window.addEventListener('mousemove', (e) => {
      if (drag) { view.ox = e.clientX - drag.x; view.oy = e.clientY - drag.y; userZoomed = true; }
    });

    resize();
    updateZoomLabel();
    draw();
  </script>
</body>
</html>`;
  }

  private _scoreBadgeClass(score: QueryScore): string {
    if (score.total >= 90) return 'badge-a';
    if (score.total >= 75) return 'badge-b';
    if (score.total >= 60) return 'badge-c';
    if (score.total >= 40) return 'badge-d';
    return 'badge-f';
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

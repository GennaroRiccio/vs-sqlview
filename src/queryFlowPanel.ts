import * as vscode from 'vscode';
import { SqlQueryPlan } from './sqlParser';
import { AnalysisResult, QueryScore } from './performanceAnalyzer';
import { buildMarkdownReport } from './report';

interface FlowNode {
  id: string;
  label: string;
  subtitle: string;
  kind: 'cte' | 'table' | 'join' | 'filter' | 'group' | 'having' | 'project' | 'sort' | 'limit' | 'result' | 'badge';
  detail: string;
}

export class QueryFlowPanel {
  private static currentPanel: QueryFlowPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _lastPlan: SqlQueryPlan | undefined;
  private _lastResult: AnalysisResult | undefined;

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'exportPng' && typeof msg.dataUrl === 'string') {
          await this.savePng(msg.dataUrl);
        } else if (msg.type === 'exportMarkdown') {
          await this.saveMarkdown();
        }
      },
      null,
      this._disposables
    );
  }

  static createOrShow(extensionUri: vscode.Uri, plan: SqlQueryPlan, result?: AnalysisResult) {
    const column = vscode.ViewColumn.Beside;

    if (QueryFlowPanel.currentPanel) {
      QueryFlowPanel.currentPanel._panel.reveal(column);
      QueryFlowPanel.currentPanel._update(plan, result);
      return;
    }

    const panel = vscode.window.createWebviewPanel('queryFlow', 'SQL Query Flow', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
    });

    QueryFlowPanel.currentPanel = new QueryFlowPanel(panel);
    QueryFlowPanel.currentPanel._update(plan, result);
  }

  dispose() {
    QueryFlowPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private _update(plan: SqlQueryPlan, result?: AnalysisResult) {
    this._lastPlan = plan;
    this._lastResult = result;
    this._panel.webview.html = this._getHtml(this._buildFlow(plan), result?.score);
  }

  private async savePng(dataUrl: string) {
    try {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('vs-sqlview-flow.png'),
        filters: { Immagini: ['png'] },
        saveLabel: 'Salva PNG',
      });
      if (!uri) return;
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, 'base64'));
      vscode.window.showInformationMessage(`Flow salvato in ${uri.fsPath}`);
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
      await vscode.workspace.fs.writeFile(uri, Buffer.from(buildMarkdownReport(this._lastPlan, this._lastResult), 'utf8'));
      vscode.window.showInformationMessage(`Report salvato in ${uri.fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Export report fallito: ${error}`);
    }
  }

  private _buildFlow(plan: SqlQueryPlan): FlowNode[] {
    const nodes: FlowNode[] = [];
    let n = 0;
    const nid = (p: string) => `${p}_${n++}`;

    for (const cte of plan.ctes ?? []) {
      nodes.push({
        id: nid('cte'),
        label: cte,
        subtitle: 'CTE / WITH',
        kind: 'cte',
        detail: `Common Table Expression "${cte}" valutata prima della query principale.`,
      });
    }

    if (plan.tables.length === 0) {
      nodes.push({
        id: nid('src'),
        label: 'SOURCE',
        subtitle: 'no FROM',
        kind: 'table',
        detail: 'Query senza clausola FROM (es. SELECT di espressioni).',
      });
    }

    for (const t of plan.tables) {
      const label = t.alias ? `${t.name} AS ${t.alias}` : t.name;
      if (t.joinType) {
        nodes.push({
          id: nid('join'),
          label: `${t.joinType} JOIN`,
          subtitle: t.joinCondition ?? 'join',
          kind: 'join',
          detail: `Join ${t.joinType} verso ${label}` + (t.joinCondition ? `\nON ${t.joinCondition}` : '\nSenza condizione ON esplicita.'),
        });
      }
      nodes.push({
        id: nid('table'),
        label,
        subtitle: t.joinType ? `joined · ${t.joinType}` : 'FROM',
        kind: 'table',
        detail: `Tabella sorgente ${label}. Le righe partono da qui e scorrono verso destra.`,
      });
    }

    if (plan.hasSubquery) {
      nodes.push({
        id: nid('sub'),
        label: 'SUBQUERY',
        subtitle: 'nested SELECT',
        kind: 'badge',
        detail: 'La query contiene una SELECT annidata. Valuta se riscriverla con JOIN.',
      });
    }

    if (plan.hasUnion) {
      nodes.push({
        id: nid('union'),
        label: 'UNION',
        subtitle: 'merge rami',
        kind: 'badge',
        detail: 'UNION unisce i rami di due SELECT. Ogni ramo viene eseguito e poi fuso.',
      });
    }

    if (plan.whereConditions.length > 0) {
      nodes.push({
        id: nid('where'),
        label: `WHERE ×${plan.whereConditions.length}`,
        subtitle: plan.whereConditions[0].slice(0, 40),
        kind: 'filter',
        detail: `Filtri:\n- ${plan.whereConditions.join('\n- ')}`,
      });
    }

    if (plan.groupByColumns.length > 0 || plan.columns.some((c) => c.isAggregate)) {
      nodes.push({
        id: nid('group'),
        label: 'GROUP BY',
        subtitle: plan.groupByColumns.join(', ').slice(0, 40) || 'aggregazione',
        kind: 'group',
        detail:
          (plan.groupByColumns.length ? `Raggruppa per: ${plan.groupByColumns.join(', ')}` : 'Solo funzioni aggregate') +
          `\nColonne: ${plan.columns.map((c) => c.alias ?? c.name).join(', ').slice(0, 200)}`,
      });
    }

    if (plan.havingConditions.length > 0) {
      nodes.push({
        id: nid('having'),
        label: `HAVING ×${plan.havingConditions.length}`,
        subtitle: plan.havingConditions[0].slice(0, 40),
        kind: 'having',
        detail: `Filtri post-aggregazione:\n- ${plan.havingConditions.join('\n- ')}`,
      });
    }

    nodes.push({
      id: nid('select'),
      label: `SELECT ×${Math.max(plan.columns.length, 1)}`,
      subtitle: plan.columns
        .map((c) => c.alias ?? c.name)
        .join(', ')
        .slice(0, 40),
      kind: 'project',
      detail: `Proiezione colonne:\n- ${plan.columns.map((c) => `${c.table ? c.table + '.' : ''}${c.name}${c.alias ? ' AS ' + c.alias : ''}`).join('\n- ') || '(nessuna)'}`,
    });

    if (plan.orderByColumns.length > 0) {
      nodes.push({
        id: nid('sort'),
        label: 'ORDER BY',
        subtitle: plan.orderByColumns.join(', ').slice(0, 40),
        kind: 'sort',
        detail: `Ordinamento per: ${plan.orderByColumns.join(', ')}`,
      });
    }

    if (plan.limit !== undefined || plan.offset !== undefined) {
      nodes.push({
        id: nid('limit'),
        label: `LIMIT ${plan.limit ?? '∞'}${plan.offset ? ' OFFSET ' + plan.offset : ''}`,
        subtitle: 'taglia il flusso',
        kind: 'limit',
        detail: 'Il flusso viene troncato: passano solo le prime N righe (ed eventuale OFFSET).',
      });
    }

    nodes.push({
      id: nid('result'),
      label: 'RESULT',
      subtitle: `${plan.type} · ${nodes.length} step`,
      kind: 'result',
      detail: 'Risultato finale restituito al client. Il flusso animato termina qui.',
    });

    return nodes;
  }

  private _escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private _getHtml(nodes: FlowNode[], score?: QueryScore): string {
    const data = JSON.stringify(nodes.map((x) => ({ ...x, detail: x.detail }))).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SQL Query Flow</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:#1e1e2e;color:#cdd6f4;height:100vh;overflow:hidden}
.top{background:#181825;padding:10px 16px;border-bottom:1px solid #313244;display:flex;justify-content:space-between;align-items:center}
.top h1{font-size:15px;color:#94e2d5}
.controls{display:flex;gap:8px;align-items:center;font-size:12px;color:#a6adc8}
.controls button{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:4px 10px;cursor:pointer}
.controls button:hover{border-color:#94e2d5}
.wrap{display:grid;grid-template-columns:1fr 320px;height:calc(100vh - 96px)}
#cv{width:100%;height:100%;display:block;cursor:grab}
.side{background:#181825;border-left:1px solid #313244;padding:14px;overflow-y:auto}
.side h2{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#a6adc8;margin-bottom:8px}
#detail{background:#1e1e2e;border:1px solid #313244;border-radius:8px;padding:12px;font-size:12px;line-height:1.5;white-space:pre-wrap}
#detail .k{font-size:10px;font-weight:700;color:#94e2d5}
.step{background:#1e1e2e;border:1px solid #313244;border-radius:6px;padding:8px;margin-top:8px;font-size:12px;cursor:pointer}
.step.active{border-color:#94e2d5}
.foot{background:#181825;border-top:1px solid #313244;padding:6px 16px;font-size:11px;color:#6c7086;display:flex;gap:14px;align-items:center}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px}
.hint{font-size:11px;color:#6c7086;margin-top:8px}
</style></head>
<body>
<div class="top"><h1>⚡ SQL Query Flow — animazione percorso</h1>
<div class="controls">
${score ? `<span style="background:#94e2d522;color:#94e2d5;border-radius:12px;padding:4px 10px;font-weight:700">Score ${score.total} · ${score.grade}</span>` : ''}
<button id="pngBtn" title="Salva il grafo come PNG">📷 PNG</button>
<button id="mdBtn" title="Salva il report come Markdown">📝 Report</button>
<button id="playBtn">⏸ Pausa</button>
<label>Velocità <input id="speed" type="range" min="1" max="10" value="4"></label>
<button id="resetBtn">Reset vista</button>
</div></div>
<div class="wrap"><div><canvas id="cv"></canvas></div>
<div class="side"><h2>Dettaglio nodo</h2><div id="detail">Clicca un nodo del grafo.</div>
<h2 style="margin-top:12px">Step (${nodes.length})</h2><div id="steps"></div>
<div class="hint">Rotella = zoom · trascina = pan · click nodo = evidenzia ramo.</div></div></div>
<div class="foot"><span><span class="dot" style="background:#89b4fa"></span>tabelle</span><span><span class="dot" style="background:#cba6f7"></span>join</span><span><span class="dot" style="background:#fab387"></span>filtri</span><span><span class="dot" style="background:#a6e3a1"></span>group</span><span><span class="dot" style="background:#94e2d5"></span>result</span><span style="margin-left:auto">VS-SQLView flow</span></div>
<script>
const vscodeApi = acquireVsCodeApi();
document.getElementById('pngBtn').onclick = () => {
  vscodeApi.postMessage({ type: 'exportPng', dataUrl: document.getElementById('cv').toDataURL('image/png') });
};
document.getElementById('mdBtn').onclick = () => {
  vscodeApi.postMessage({ type: 'exportMarkdown' });
};
const NODES=${data};
const COLORS={cte:'#74c7ec',table:'#89b4fa',join:'#cba6f7',filter:'#fab387',group:'#a6e3a1',having:'#f9e2af',project:'#94e2d5',sort:'#f38ba8',limit:'#fab387',result:'#a6e3a1',badge:'#eba0ac'};
const cv=document.getElementById('cv'),ctx=cv.getContext('2d');
let W=0,H=0,playing=true,speed=4,t=0,selected=-1,expanded=-1;
let view={s:1,ox:0,oy:0};
const NW=230,NH=64,GAP=44;
function detailLines(n){return String(n.detail||'').split('\\n').slice(0,8);}
function nodeH(n,i){if(i!==expanded)return NH;return NH+detailLines(n).length*14+22;}
function layout(){const cx=W/2;let y=80;NODES.forEach((n,i)=>{n._h=nodeH(n,i);n._x=cx+((i%2===0)?-30:30);n._y=y+n._h/2;y+=n._h+GAP;});}
function resize(){const r=cv.parentElement.getBoundingClientRect(),d=window.devicePixelRatio||1;W=r.width;H=r.height;cv.width=W*d;cv.height=H*d;cv.style.width=W+'px';cv.style.height=H+'px';ctx.setTransform(d,0,0,d,0,0);layout();}
function toScreen(x,y){return [x*view.s+view.ox,y*view.s+view.oy];}
function edgePath(a,b){const [x1,y1]=toScreen(a._x,a._y+a._h/2);const [x2,y2]=toScreen(b._x,b._y-b._h/2);return {x1,y1,x2,y2,my:(y1+y2)/2};}
function draw(){ctx.clearRect(0,0,W,H);
for(let i=0;i<NODES.length-1;i++){const a=NODES[i],b=NODES[i+1];const {x1,y1,x2,y2,my}=edgePath(a,b);
const active=(selected<0)||(i===selected||i===selected-1);
ctx.beginPath();ctx.strokeStyle=active?'#585b70':'#313244';ctx.lineWidth=active?2.5:1.5;
ctx.moveTo(x1,y1);ctx.bezierCurveTo(x1,my,x2,my,x2,y2);ctx.stroke();
if(playing&&active){const nDots=2;for(let k=0;k<nDots;k++){const p=((t*0.004*speed)+k/nDots+i*0.13)%1;
const px=(1-p)*(1-p)*(1-p)*x1+3*(1-p)*(1-p)*p*x1+3*(1-p)*p*p*x2+p*p*p*x2;
const py=(1-p)*(1-p)*(1-p)*y1+3*(1-p)*(1-p)*p*my+3*(1-p)*p*p*my+p*p*p*y2;
ctx.beginPath();ctx.fillStyle=COLORS[b.kind]||'#fff';ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=12;ctx.arc(px,py,4.5,0,7);ctx.fill();ctx.shadowBlur=0;}}}
NODES.forEach((n,i)=>{const [x,y]=toScreen(n._x,n._y);const h=n._h*view.s;const col=COLORS[n.kind]||'#89b4fa';const sel=i===selected;const exp=i===expanded;
ctx.save();ctx.shadowColor=col;ctx.shadowBlur=sel?22:10;
ctx.beginPath();
if(ctx.roundRect)ctx.roundRect(x-NW/2*view.s,y-h/2,NW*view.s,h,10);else ctx.rect(x-NW/2*view.s,y-h/2,NW*view.s,h);
ctx.fillStyle='#11111b';ctx.fill();ctx.lineWidth=sel?3:2;ctx.strokeStyle=col;ctx.stroke();ctx.restore();
ctx.fillStyle=col;ctx.font='bold 12px Segoe UI';ctx.textAlign='center';
const lab=String(n.label||'');const labT=lab.length>24?lab.slice(0,22)+'…':lab;
ctx.fillText((exp?'▼ ':'▶ ')+labT,x,y-h/2+18*view.s);
ctx.fillStyle='#a6adc8';ctx.font='10px Segoe UI';
const sub=(n.subtitle||'').length>30?n.subtitle.slice(0,28)+'…':n.subtitle;
ctx.fillText(sub||n.kind.toUpperCase(),x,y-h/2+34*view.s);
if(exp){ctx.strokeStyle='#313244';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x-NW/2*view.s+10,y-h/2+44*view.s);ctx.lineTo(x+NW/2*view.s-10,y-h/2+44*view.s);ctx.stroke();
ctx.fillStyle='#cdd6f4';ctx.font='10px Segoe UI';detailLines(n).forEach((ln,j)=>{let s=ln.length>32?ln.slice(0,30)+'…':ln;ctx.fillText(s,x,y-h/2+(60+j*14)*view.s);});}
else{ctx.fillStyle='#585b70';ctx.font='10px Segoe UI';ctx.fillText((i+1)+'/'+NODES.length+' · click per espandere',x,y+h/2-8);}});
if(playing)t++;requestAnimationFrame(draw);}
function select(i,toggle){selected=i;if(toggle){expanded=(expanded===i)?-1:i;layout();}const d=document.getElementById('detail');if(i<0||!NODES[i]){d.textContent='Clicca un nodo del grafo.';}else{const n=NODES[i];d.innerHTML='<div class=k>'+n.kind.toUpperCase()+' · step '+(i+1)+'/'+NODES.length+'</div><b>'+n.label+'</b><br>'+(n.subtitle||'')+'<br><br>'+String(n.detail||'').replace(/</g,'&lt;');}
document.querySelectorAll('.step').forEach((el,j)=>el.classList.toggle('active',j===i));}
const steps=document.getElementById('steps');
NODES.forEach((n,i)=>{const el=document.createElement('div');el.className='step';el.textContent=(i+1)+'. '+n.label+' — '+n.kind;el.onclick=()=>select(i,true);steps.appendChild(el);});
let downPos=null;cv.addEventListener('mousedown',e=>{downPos={x:e.clientX,y:e.clientY};});
cv.addEventListener('click',e=>{if(downPos&&Math.hypot(e.clientX-downPos.x,e.clientY-downPos.y)>6)return;
const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
let best=-1;NODES.forEach((n,i)=>{const [x,y]=toScreen(n._x,n._y);const dx=Math.abs(mx-x)-NW*view.s/2,dy=Math.abs(my-y)-n._h*view.s/2;if(dx<0&&dy<0)best=i;});select(best,true);});
let drag=null;cv.addEventListener('mousedown',e=>{drag={x:e.clientX-view.ox,y:e.clientY-view.oy};cv.style.cursor='grabbing';});
window.addEventListener('mouseup',()=>{drag=null;cv.style.cursor='grab';});
window.addEventListener('mousemove',e=>{if(drag){view.ox=e.clientX-drag.x;view.oy=e.clientY-drag.y;}});
cv.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY<0?1.1:0.9;view.s=Math.min(2.2,Math.max(0.4,view.s*f));},{passive:false});
document.getElementById('playBtn').onclick=e=>{playing=!playing;e.target.textContent=playing?'⏸ Pausa':'▶ Play';};
document.getElementById('speed').oninput=e=>speed=+e.target.value;
document.getElementById('resetBtn').onclick=()=>{view={s:1,ox:0,oy:0};};
window.addEventListener('resize',resize);resize();draw();
</script></body></html>`;
  }
}

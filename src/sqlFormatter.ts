export interface FormatOptions {
  keywordCase: 'upper' | 'lower' | 'preserve';
  indentWidth: number;
}

type TokType = 'word' | 'str' | 'comment' | 'lp' | 'rp' | 'comma' | 'semi' | 'op' | 'dot';

interface Tok {
  t: TokType;
  v: string;
}

const CLAUSES = new Set([
  'SELECT',
  'SELECT DISTINCT',
  'SELECT ALL',
  'FROM',
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'UNION',
  'UNION ALL',
  'UNION DISTINCT',
  'EXCEPT',
  'EXCEPT ALL',
  'EXCEPT DISTINCT',
  'INTERSECT',
  'INTERSECT ALL',
  'INTERSECT DISTINCT',
  'VALUES',
  'WINDOW',
  'SET',
  'INSERT INTO',
  'DELETE FROM',
]);

const MISC_KW = new Set([
  'AS', 'ASC', 'DESC', 'NOT', 'NULL', 'NULLS', 'INTO', 'IN', 'LIKE', 'ILIKE',
  'EXISTS', 'IS', 'TRUE', 'FALSE', 'ANY', 'ALL', 'SOME', 'BETWEEN', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'ON', 'USING',
]);

const JOIN_START = new Set(['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'JOIN']);

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  const re =
    /(--[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`)|\b([A-Za-z_][\w$]*)\b|(\d+(?:\.\d+)?)|(\(|\)|,|;|\.|<>|!=|<=|>=|\|\||=|<|>|\+|-|\*|\/|%)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) toks.push({ t: 'comment', v: m[1] });
    else if (m[2]) toks.push({ t: 'comment', v: m[2] });
    else if (m[3]) toks.push({ t: 'str', v: m[3] });
    else if (m[4]) toks.push({ t: 'word', v: m[4] });
    else if (m[5]) toks.push({ t: 'word', v: m[5] });
    else if (m[6] === '(') toks.push({ t: 'lp', v: '(' });
    else if (m[6] === ')') toks.push({ t: 'rp', v: ')' });
    else if (m[6] === ',') toks.push({ t: 'comma', v: ',' });
    else if (m[6] === ';') toks.push({ t: 'semi', v: ';' });
    else if (m[6] === '.') toks.push({ t: 'dot', v: '.' });
    else toks.push({ t: 'op', v: m[6] });
  }
  return toks;
}

function combineKeywords(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const up = (t: Tok) => t.v.toUpperCase();
  while (i < toks.length) {
    const t = toks[i];
    if (t.t === 'word') {
      const w = up(t);
      const nxt = toks[i + 1];
      const nxt2 = toks[i + 2];
      if ((w === 'GROUP' || w === 'ORDER') && nxt && nxt.t === 'word' && up(nxt) === 'BY') {
        out.push({ t: 'word', v: `${w} BY` });
        i += 2;
        continue;
      }
      if ((w === 'UNION' || w === 'EXCEPT' || w === 'INTERSECT') && nxt && nxt.t === 'word' && (up(nxt) === 'ALL' || up(nxt) === 'DISTINCT')) {
        out.push({ t: 'word', v: `${w} ${up(nxt)}` });
        i += 2;
        continue;
      }
      if (w === 'INSERT' && nxt && nxt.t === 'word' && up(nxt) === 'INTO') {
        out.push({ t: 'word', v: 'INSERT INTO' });
        i += 2;
        continue;
      }
      if (w === 'DELETE' && nxt && nxt.t === 'word' && up(nxt) === 'FROM') {
        out.push({ t: 'word', v: 'DELETE FROM' });
        i += 2;
        continue;
      }
      if (w === 'SELECT' && nxt && nxt.t === 'word' && (up(nxt) === 'DISTINCT' || up(nxt) === 'ALL')) {
        out.push({ t: 'word', v: `SELECT ${up(nxt)}` });
        i += 2;
        continue;
      }
      if (JOIN_START.has(w)) {
        const parts = [w];
        let j = i + 1;
        const jn = toks[j];
        if (jn && jn.t === 'word' && up(jn) === 'OUTER') {
          parts.push('OUTER');
          j++;
        }
        const jj = toks[j];
        if ((w === 'JOIN' && parts.length === 1) || (jj && jj.t === 'word' && up(jj) === 'JOIN')) {
          if (w !== 'JOIN') {
            parts.push('JOIN');
            j++;
          }
          out.push({ t: 'word', v: parts.join(' ') });
          i = j;
          continue;
        }
      }
    }
    out.push(t);
    i++;
  }
  return out;
}

export function formatSql(sql: string, options: FormatOptions): string {
  const indentUnit = ' '.repeat(Math.max(0, Math.min(8, options.indentWidth || 2)));
  const toks = combineKeywords(tokenize(sql));
  if (toks.length === 0) return sql;

  const kw = (v: string): string => {
    if (options.keywordCase === 'upper') return v.toUpperCase();
    if (options.keywordCase === 'lower') return v.toLowerCase();
    return v;
  };

  let out = '';
  let depth = 0;
  const funcStack: boolean[] = [];
  let listMode = false;
  let listDepth = -1;
  let betweenOpen = false;
  const caseStack: number[] = [];
  let needNewline = false;
  let pendingIndent: number | undefined;

  const indent = (n: number) => indentUnit.repeat(Math.max(0, n));
  const nl = (n: number) => {
    out = out.replace(/[ \t]+$/, '');
    if (out.endsWith('\n')) out += indent(n);
    else out += '\n' + indent(n);
  };
  const isClauseWord = (v: string) => CLAUSES.has(v.toUpperCase());
  const isJoinWord = (v: string) => /JOIN$/.test(v.toUpperCase());

  const emitWord = (text: string) => {
    if (needNewline) {
      nl(pendingIndent ?? depth);
      needNewline = false;
      pendingIndent = undefined;
    } else if (pendingIndent !== undefined) {
      nl(pendingIndent);
      pendingIndent = undefined;
    } else if (out.length > 0 && !out.endsWith('\n') && !out.endsWith(' ') && !out.endsWith('(') && !out.endsWith('.') && !out.endsWith('-') && !out.endsWith('+')) {
      out += ' ';
    }
    out += text;
  };

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prev = i > 0 ? toks[i - 1] : undefined;

    if (tok.t === 'comment') {
      if (tok.v.startsWith('--')) {
        if (out.length > 0 && !out.endsWith('\n')) {
          out = out.replace(/[ \t]+$/, '');
          out += '  ' + tok.v;
        } else {
          out += indent(depth) + tok.v;
        }
        out += '\n' + indent(depth);
      } else {
        emitWord(tok.v);
      }
      continue;
    }

    if (tok.t === 'semi') {
      out = out.replace(/[ \t]+$/, '');
      out += ';';
      listMode = false;
      out += '\n\n';
      needNewline = false;
      pendingIndent = undefined;
      continue;
    }

    if (tok.t === 'lp') {
      const prevWord = prev && prev.t === 'word' ? prev.v.toUpperCase() : '';
      if (prevWord === 'OVER') {
        if (out.length > 0 && !out.endsWith('\n') && !out.endsWith(' ') && !out.endsWith('(')) out += ' ';
        out += '(';
        funcStack.push(true);
        continue;
      }
      const prevWordBlock = ['IN', 'EXISTS', 'ANY', 'ALL', 'SOME'].includes(prevWord);
      const isFunc =
        !!prev &&
        (prev.t === 'str' ||
          prev.t === 'rp' ||
          (prev.t === 'word' && !prevWordBlock && !isClauseWord(prevWord) && !isJoinWord(prevWord) && prevWord !== 'ON' && prevWord !== 'USING' && prevWord !== 'CASE' && prevWord !== 'WHEN' && prevWord !== 'THEN' && prevWord !== 'ELSE') ||
          prev.t === 'dot');
      if (isFunc) {
        out = out.replace(/[ \t]+$/, '');
        out += '(';
        funcStack.push(true);
      } else {
        if (out.length > 0 && !out.endsWith('\n') && !out.endsWith(' ') && !out.endsWith('(')) out += ' ';
        out += '(';
        funcStack.push(false);
        depth++;
        nl(depth);
      }
      continue;
    }

    if (tok.t === 'rp') {
      const wasFunc = funcStack.pop() ?? true;
      if (wasFunc) {
        out = out.replace(/[ \t]+$/, '');
        out += ')';
      } else {
        depth = Math.max(0, depth - 1);
        if (listDepth > depth) listMode = false;
        nl(depth);
        out += ')';
      }
      continue;
    }

    if (tok.t === 'comma') {
      const inFunc = funcStack.length > 0 && funcStack[funcStack.length - 1] === true;
      if (listMode && depth === listDepth && !inFunc) {
        out += ',';
        nl(depth + 1);
      } else {
        out = out.replace(/[ \t]+$/, '');
        out += ', ';
      }
      continue;
    }

    if (tok.t === 'dot') {
      out = out.replace(/[ \t]+$/, '');
      out += '.';
      continue;
    }

    if (tok.t === 'op') {
      const isUnary = tok.v === '-' || tok.v === '+'
        ? !prev || prev.t === 'lp' || prev.t === 'comma' || prev.t === 'op' || prev.t === 'semi' ||
          (prev.t === 'word' && (isClauseWord(prev.v) || isJoinWord(prev.v) || ['ON', 'USING', 'WHEN', 'THEN', 'ELSE', 'AND', 'OR', 'AS', 'BY', 'IN', 'NOT', 'BETWEEN'].includes(prev.v.toUpperCase())))
        : false;
      if (isUnary) {
        if (out.length > 0 && !out.endsWith('\n') && !out.endsWith('(') && !out.endsWith(' ')) out += ' ';
        out += tok.v;
      } else {
        out = out.replace(/[ \t]+$/, '');
        if (out.length > 0 && !out.endsWith('\n') && !out.endsWith('(')) out += ' ';
        out += tok.v + ' ';
      }
      continue;
    }

    if (tok.t === 'str') {
      emitWord(tok.v);
      continue;
    }

    const w = tok.v.toUpperCase();

    const inFuncParen = funcStack.length > 0 && funcStack[funcStack.length - 1] === true;
    if (inFuncParen) {
      emitWord(isClauseWord(w) || isJoinWord(w) || MISC_KW.has(w) ? kw(tok.v) : tok.v);
      continue;
    }

    if (w === 'BETWEEN') {
      emitWord(kw('BETWEEN'));
      betweenOpen = true;
      continue;
    }

    if (w === 'AND' || w === 'OR') {
      if (betweenOpen && w === 'AND') {
        emitWord(kw('AND'));
        betweenOpen = false;
        continue;
      }
      const inFunc = funcStack[funcStack.length - 1] === true;
      if (inFunc) {
        emitWord(kw(w));
      } else {
        nl(depth + 1);
        out += kw(w) + ' ';
        listMode = false;
      }
      continue;
    }

    if (w === 'ON' || w === 'USING') {
      nl(depth + 1);
      out += kw(w) + ' ';
      listMode = false;
      continue;
    }

    if (w === 'CASE') {
      emitWord(kw('CASE'));
      caseStack.push(depth + 1);
      continue;
    }
    if (w === 'WHEN') {
      const ci = caseStack.length > 0 ? caseStack[caseStack.length - 1] : depth + 1;
      nl(ci);
      out += kw('WHEN') + ' ';
      continue;
    }
    if (w === 'THEN') {
      out = out.replace(/[ \t]+$/, '');
      out += ' ' + kw('THEN') + ' ';
      continue;
    }
    if (w === 'ELSE') {
      const ci = caseStack.length > 0 ? caseStack[caseStack.length - 1] : depth + 1;
      nl(ci);
      out += kw('ELSE') + ' ';
      continue;
    }
    if (w === 'END') {
      const ci = caseStack.length > 0 ? caseStack.pop()! : depth;
      nl(ci);
      out += kw('END');
      continue;
    }

    if (isClauseWord(w)) {
      nl(depth);
      out += kw(tok.v);
      if (w.startsWith('SELECT') || w === 'GROUP BY' || w === 'ORDER BY') {
        listMode = true;
        listDepth = depth;
        pendingIndent = depth + 1;
      } else if (w === 'FROM') {
        listMode = false;
        pendingIndent = depth + 1;
      } else {
        listMode = false;
        if (w === 'VALUES') pendingIndent = depth + 1;
        else out += ' ';
      }
      continue;
    }

    if (isJoinWord(w)) {
      nl(depth);
      out += kw(tok.v) + ' ';
      listMode = false;
      continue;
    }

    if (['AS', 'ASC', 'DESC', 'NOT', 'NULL', 'NULLS', 'INTO', 'IN', 'LIKE', 'ILIKE', 'EXISTS', 'IS', 'TRUE', 'FALSE', 'ANY', 'ALL', 'SOME'].includes(w)) {
      emitWord(kw(w));
      continue;
    }

    emitWord(tok.v);
  }

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

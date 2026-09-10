// A tiny SQL front-end mirroring pyiceberg's own query-planning behavior:
// pruning data files by column min/max stats before ever "reading" them.
// Fully client-side — no real files, just the same decision logic.

const STMT_RE = new RegExp(
  '^\\s*select\\s+(.*?)\\s+from\\s+([\\w."]+)' +
  '(?:\\s+where\\s+(.*?))?' +
  '(?:\\s+order\\s+by\\s+(\\w+)(?:\\s+(asc|desc))?)?' +
  '(?:\\s+limit\\s+(\\d+))?' +
  '\\s*;?\\s*$',
  'is'
);

function parseSql(sql) {
  const m = STMT_RE.exec(sql.trim());
  if (!m) throw new Error('only SELECT ... FROM ... [WHERE ...] [ORDER BY ...] [LIMIT n] is supported');
  const colsRaw = m[1].trim();
  const columns = colsRaw === '*' ? null : colsRaw.split(',').map(c => c.trim()).filter(Boolean);
  return {
    columns,
    where: (m[3] || '').trim() || null,
    orderBy: m[4] || null,
    orderDir: (m[5] || 'asc').toLowerCase(),
    limit: m[6] ? parseInt(m[6], 10) : null,
  };
}

// ---- WHERE-clause tokenizer + recursive-descent parser ----
function tokenize(s) {
  const tokens = [];
  const re = /\s*(<=|>=|!=|<>|=|<|>|\(|\)|,|'[^']*'|"[^"]*"|[A-Za-z_][\w.]*|-?\d+\.\d+|-?\d+)\s*/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m || m.index !== i) throw new Error(`cannot parse WHERE clause near: ${s.slice(i, i + 20)}`);
    tokens.push(m[1]);
    i = re.lastIndex;
  }
  return tokens;
}

function parseExpr(sql) {
  const tokens = tokenize(sql);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().toLowerCase() === 'or') {
      next();
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().toLowerCase() === 'and') {
      next();
      left = { type: 'and', left, right: parseNot() };
    }
    return left;
  }
  function parseNot() {
    if (peek() && peek().toLowerCase() === 'not') {
      next();
      return { type: 'not', node: parseNot() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    if (peek() === '(') {
      next();
      const node = parseOr();
      if (peek() !== ')') throw new Error("expected ')'");
      next();
      return node;
    }
    const field = next();
    if (field === undefined) throw new Error('unexpected end of WHERE clause');
    const op = peek();
    if (op && op.toLowerCase() === 'is') {
      next();
      let neg = false;
      if (peek() && peek().toLowerCase() === 'not') { next(); neg = true; }
      if (!peek() || peek().toLowerCase() !== 'null') throw new Error("expected NULL after IS [NOT]");
      next();
      return { type: neg ? 'isnotnull' : 'isnull', field };
    }
    if (op && op.toLowerCase() === 'in') {
      next();
      if (peek() !== '(') throw new Error("expected '(' after IN");
      next();
      const values = [];
      while (peek() !== ')') {
        values.push(literal(next()));
        if (peek() === ',') next();
      }
      next();
      return { type: 'in', field, values };
    }
    if (!['=', '!=', '<>', '<', '<=', '>', '>='].includes(op)) {
      throw new Error(`expected a comparison operator after ${field}, got: ${op}`);
    }
    next();
    const value = literal(next());
    return { type: 'cmp', field, op: op === '<>' ? '!=' : op, value };
  }

  function literal(tok) {
    if (tok === undefined) throw new Error('unexpected end of WHERE clause');
    if (/^'.*'$/.test(tok) || /^".*"$/.test(tok)) return tok.slice(1, -1);
    if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
    if (/^-?\d+\.\d+$/.test(tok)) return parseFloat(tok);
    if (tok.toLowerCase() === 'true') return true;
    if (tok.toLowerCase() === 'false') return false;
    throw new Error(`invalid literal: ${tok}`);
  }

  const ast = parseOr();
  if (pos !== tokens.length) throw new Error(`unexpected trailing input near: ${tokens.slice(pos).join(' ')}`);
  return ast;
}

function evalRow(row, node) {
  switch (node.type) {
    case 'and': return evalRow(row, node.left) && evalRow(row, node.right);
    case 'or': return evalRow(row, node.left) || evalRow(row, node.right);
    case 'not': return !evalRow(row, node.node);
    case 'isnull': return row[node.field] === null || row[node.field] === undefined;
    case 'isnotnull': return !(row[node.field] === null || row[node.field] === undefined);
    case 'in': return node.values.includes(row[node.field]);
    case 'cmp': {
      const v = row[node.field];
      if (v === null || v === undefined) return false;
      switch (node.op) {
        case '=': return v === node.value;
        case '!=': return v !== node.value;
        case '<': return v < node.value;
        case '<=': return v <= node.value;
        case '>': return v > node.value;
        case '>=': return v >= node.value;
      }
    }
    default: return true;
  }
}

// Conservative min/max-stats pruning, mirroring pyiceberg's InclusiveMetricsEvaluator:
// returns true only when the file's stats PROVE no row could match.
function canPruneFile(stats, node) {
  switch (node.type) {
    case 'and': return canPruneFile(stats, node.left) || canPruneFile(stats, node.right);
    case 'or': return canPruneFile(stats, node.left) && canPruneFile(stats, node.right);
    case 'not': return false; // conservative
    case 'in': {
      const stat = stats[node.field];
      if (!stat) return false;
      return node.values.every(v => (typeof v === 'number') && (v < stat.min || v > stat.max));
    }
    case 'cmp': {
      const stat = stats[node.field];
      if (!stat || typeof node.value !== 'number') return false;
      switch (node.op) {
        case '=': return node.value < stat.min || node.value > stat.max;
        case '>': return node.value >= stat.max;
        case '>=': return node.value > stat.max;
        case '<': return node.value <= stat.min;
        case '<=': return node.value < stat.min;
        default: return false; // != can't generally be proven false via a range
      }
    }
    default: return false;
  }
}

// db: the sim-engine `db`. Returns the same shape the old Python /api/query did.
function runQuery(db, sql, reachableFn) {
  const parsed = parseSql(sql);
  const ast = parsed.where ? parseExpr(parsed.where) : null;

  const { dataFileIds } = reachableFn(db);
  const scannedIds = [];
  let matched = [];

  dataFileIds.forEach(id => {
    const df = db.dataFiles[id];
    if (ast && canPruneFile(df.stats, ast)) return; // pruned — never "read"
    scannedIds.push(`df-${df.id}`);
    const rows = ast ? df.rows.filter(r => evalRow(r, ast)) : df.rows.slice();
    matched.push(...rows);
  });

  const allCols = db.schema.map(f => f.name);
  const columns = parsed.columns || allCols;
  columns.forEach(c => {
    if (!allCols.includes(c)) throw new Error(`unknown column: ${c}`);
  });

  if (parsed.orderBy) {
    if (!allCols.includes(parsed.orderBy)) throw new Error(`unknown column in ORDER BY: ${parsed.orderBy}`);
    const dir = parsed.orderDir === 'desc' ? -1 : 1;
    matched = matched.slice().sort((a, b) => {
      const av = a[parsed.orderBy], bv = b[parsed.orderBy];
      if (av === bv) return 0;
      return av < bv ? -1 * dir : 1 * dir;
    });
  }
  if (parsed.limit !== null) matched = matched.slice(0, parsed.limit);

  const rows = matched.map(r => {
    const out = {};
    columns.forEach(c => (out[c] = c in r ? r[c] : null));
    return out;
  });

  return {
    sql,
    columns,
    rows,
    row_count: rows.length,
    scanned_data_files: scannedIds,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSql, parseExpr, evalRow, canPruneFile, runQuery };
}

import * as assert from 'assert';
import { SqlParser } from '../../sqlParser';
import { PerformanceAnalyzer } from '../../performanceAnalyzer';
import { parseSchema } from '../../schema';
import { formatSql } from '../../sqlFormatter';

suite('VS-SQLView Unit Tests', () => {
  const parser = new SqlParser();
  const analyzer = new PerformanceAnalyzer();

  test('SqlParser parses complex SELECT queries', () => {
    const sql = `
      SELECT u.id, u.name, COUNT(o.id) AS total_orders
      FROM users u
      INNER JOIN orders o ON u.id = o.user_id
      WHERE u.status = 'active'
      GROUP BY u.id, u.name
      HAVING COUNT(o.id) > 5
      ORDER BY total_orders DESC
      LIMIT 10 OFFSET 20;
    `;
    const plan = parser.parse(sql);
    assert.strictEqual(plan.type, 'SELECT');
    assert.strictEqual(plan.tables.length, 2);
    assert.strictEqual(plan.tables[0].name, 'users');
    assert.strictEqual(plan.tables[0].alias, 'u');
    assert.strictEqual(plan.tables[1].name, 'orders');
    assert.strictEqual(plan.whereConditions.length, 1);
    assert.strictEqual(plan.groupByColumns.length, 2);
    assert.strictEqual(plan.havingConditions.length, 1);
    assert.strictEqual(plan.orderByColumns.length, 1);
    assert.strictEqual(plan.limit, 10);
    assert.strictEqual(plan.offset, 20);
  });

  test('SqlParser parses TOP and FETCH FIRST row limits', () => {
    const sqlTop = `SELECT TOP 50 id, name FROM users;`;
    const planTop = parser.parse(sqlTop);
    assert.strictEqual(planTop.limit, 50);

    const sqlFetch = `SELECT id, name FROM users FETCH FIRST 25 ROWS ONLY;`;
    const planFetch = parser.parse(sqlFetch);
    assert.strictEqual(planFetch.limit, 25);
  });

  test('PerformanceAnalyzer detects SELECT_STAR and LIKE leading wildcard', () => {
    const sql = `SELECT * FROM products WHERE description LIKE '%gadget%';`;
    const plan = parser.parse(sql);
    const result = analyzer.analyzeFull(plan);

    const selectStar = result.issues.find((i) => i.code === 'SELECT_STAR');
    assert.ok(selectStar, 'Should detect SELECT_STAR');

    const likeIndex = result.issues.find((i) => i.code === 'LIKE_INDEX');
    assert.ok(likeIndex, 'Should detect LIKE_INDEX with leading wildcard');
    assert.strictEqual(likeIndex?.severity, 'critical');
  });

  test('PerformanceAnalyzer generates index suggestions', () => {
    const sql = `SELECT u.email FROM users u WHERE u.email = 'test@example.com' AND u.status = 1;`;
    const plan = parser.parse(sql);
    const result = analyzer.analyzeFull(plan);

    assert.ok(result.indexes.length > 0, 'Should suggest index on filtered columns');
    const hasEmail = result.indexes.some((idx) => idx.columns.includes('email'));
    assert.ok(hasEmail, 'Index should include email column');
  });

  test('parseSchema extracts tables and columns from DDL', () => {
    const ddl = `
      CREATE TABLE customers (
        id INT PRIMARY KEY,
        first_name VARCHAR(50),
        last_name VARCHAR(50),
        created_at TIMESTAMP
      );
      CREATE TABLE orders (
        id INT PRIMARY KEY,
        customer_id INT,
        total DECIMAL(10, 2)
      );
    `;
    const schema = parseSchema(ddl);
    assert.ok(schema.tables['customers']);
    assert.ok(schema.tables['orders']);
    assert.deepStrictEqual(schema.tables['customers'].columns, ['id', 'first_name', 'last_name', 'created_at']);
    assert.deepStrictEqual(schema.tables['orders'].columns, ['id', 'customer_id', 'total']);
  });

  test('formatSql formats SQL and uppercases keywords', () => {
    const raw = 'select id, name from users where age > 18 order by name limit 10;';
    const formatted = formatSql(raw, { keywordCase: 'upper', indentWidth: 2 });
    assert.ok(formatted.includes('SELECT'));
    assert.ok(formatted.includes('FROM'));
    assert.ok(formatted.includes('users'));
    assert.ok(formatted.includes('WHERE'));
    assert.ok(formatted.includes('ORDER BY'));
    assert.ok(formatted.includes('LIMIT'));
  });
});

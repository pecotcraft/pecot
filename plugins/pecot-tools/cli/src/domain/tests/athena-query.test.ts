import { describe, expect, it } from 'vitest'

import { classifyAthenaQuery } from '../athena-query.js'

/**
research R6 が許可すると定めたクエリ。
*/
const ALLOWED: readonly string[] = [
  'SELECT 1',
  '  select order_id from orders limit 10',
  'WITH t AS (SELECT 1 AS n) SELECT n FROM t',
  'SHOW TABLES',
  'DESCRIBE orders',
  'DESC orders',
  'EXPLAIN SELECT 1',
  'SELECT 1;',
  '-- 直近の注文\nSELECT order_id FROM orders',
  '/* 直近の注文 */ SELECT order_id FROM orders',
]

/**
research R6 が拒否すると定めたクエリ。
*/
const NOT_READ_ONLY: readonly string[] = [
  'INSERT INTO orders VALUES (1)',
  'UPDATE orders SET total = 0',
  'DELETE FROM orders',
  'MERGE INTO orders USING staged ON orders.id = staged.id WHEN MATCHED THEN DELETE',
  'CREATE TABLE snapshot AS SELECT * FROM orders',
  'ALTER TABLE orders ADD COLUMN memo varchar',
  'DROP TABLE orders',
  'UNLOAD (SELECT * FROM orders) TO \'s3://bucket/prefix/\'',
  'MSCK REPAIR TABLE orders',
  'VALUES (1), (2)',
  'EXPLAIN ANALYZE INSERT INTO orders VALUES (1)',
]

describe('classifyAthenaQuery', () => {
  it.each(ALLOWED)('参照クエリ %j を許可する', (query) => {
    expect(classifyAthenaQuery(query)).toEqual({ allowed: true })
  })

  it.each(NOT_READ_ONLY)('変更系クエリ %j を not-read-only で拒否する', (query) => {
    expect(classifyAthenaQuery(query)).toMatchObject({ allowed: false, reason: 'not-read-only' })
  })

  it('複数の文を multi-statement で拒否する', () => {
    expect(classifyAthenaQuery('SELECT 1; DROP TABLE orders'))
      .toMatchObject({ allowed: false, reason: 'multi-statement' })
  })

  it('1 文目が空でも ; の後ろに文があれば multi-statement で拒否する', () => {
    expect(classifyAthenaQuery('; SELECT 1'))
      .toMatchObject({ allowed: false, reason: 'multi-statement' })
  })

  it('空のクエリを empty で拒否する', () => {
    expect(classifyAthenaQuery('')).toMatchObject({ allowed: false, reason: 'empty' })
    expect(classifyAthenaQuery('   \n  ')).toMatchObject({ allowed: false, reason: 'empty' })
    expect(classifyAthenaQuery('-- コメントだけ')).toMatchObject({ allowed: false, reason: 'empty' })
  })

  it('文字列リテラル内の ; は文の区切りにしない', () => {
    expect(classifyAthenaQuery('SELECT \';\'')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('SELECT \'a; DROP TABLE t\' FROM orders')).toEqual({ allowed: true })
  })

  it('引用識別子の中の ; も文の区切りにしない', () => {
    expect(classifyAthenaQuery('SELECT "col;name" FROM orders')).toEqual({ allowed: true })
  })

  it('リテラル内の -- と /* をコメント開始にしない', () => {
    expect(classifyAthenaQuery('SELECT \'-- x\' FROM orders')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('SELECT \'/* x\' FROM orders')).toEqual({ allowed: true })
  })

  it('2 重引用符でエスケープしたリテラルを閉じたものとして扱う', () => {
    // Trino のエスケープは引用符の 2 重化のみ。'' の後も同じリテラルが続く。
    expect(classifyAthenaQuery('SELECT \'it\'\'s; ok\' FROM orders')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('SELECT "a""b" FROM orders')).toEqual({ allowed: true })
  })

  it('バックスラッシュでリテラルを閉じたことにしない', () => {
    // Trino では \ は普通の文字なので 'X'; の ; はリテラル外にある = 複文。
    expect(classifyAthenaQuery(String.raw`SELECT '\'; DROP TABLE t --'`))
      .toMatchObject({ allowed: false, reason: 'multi-statement' })
  })

  it('閉じていないリテラル・コメントを unterminated で拒否する', () => {
    // 変更系とは別 reason にする。reason だけを見る呼び出し元が「変更系だから拒否」と誤読しない。
    expect(classifyAthenaQuery('SELECT \'abc')).toMatchObject({ allowed: false, reason: 'unterminated' })
    expect(classifyAthenaQuery('SELECT "abc')).toMatchObject({ allowed: false, reason: 'unterminated' })
    expect(classifyAthenaQuery('/* 閉じていない SELECT 1'))
      .toMatchObject({ allowed: false, reason: 'unterminated' })

    const rejected = classifyAthenaQuery('SELECT \'abc')
    expect(rejected.allowed ? '' : rejected.message).toContain('閉じていない')
  })

  it('EXPLAIN の修飾語とオプション群を剥がして内側を判定する', () => {
    expect(classifyAthenaQuery('EXPLAIN ANALYZE SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN ANALYZE VERBOSE SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN VERBOSE ANALYZE SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN (TYPE DISTRIBUTED) SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN (TYPE LOGICAL, FORMAT (TEXT)) SELECT 1')).toEqual({ allowed: true })
  })

  it('EXPLAIN のオプション群が閉じていなければ拒否する', () => {
    expect(classifyAthenaQuery('EXPLAIN (TYPE DISTRIBUTED SELECT 1'))
      .toMatchObject({ allowed: false, reason: 'not-read-only' })
  })

  it('EXPLAIN の内側が変更系なら拒否する', () => {
    expect(classifyAthenaQuery('EXPLAIN (TYPE DISTRIBUTED) DROP TABLE orders'))
      .toMatchObject({ allowed: false, reason: 'not-read-only' })
    expect(classifyAthenaQuery('EXPLAIN')).toMatchObject({ allowed: false, reason: 'not-read-only' })
  })

  it('EXPLAIN を 20000 段重ねてもスタックを溢れさせない', () => {
    // 1 段 1 再帰の実装だと RangeError になり、設計した失敗種別の外へ例外が抜ける。
    const query = `${'EXPLAIN '.repeat(20_000)}SELECT 1`

    expect(classifyAthenaQuery(query)).toEqual({ allowed: true })
  })

  it('末尾の ; だけなら 1 文として許可する', () => {
    expect(classifyAthenaQuery('SELECT 1 ;  \n ')).toEqual({ allowed: true })
  })

  it('拒否には再試行の手掛かりになる message を載せる', () => {
    const rejected = classifyAthenaQuery('DROP TABLE orders')

    expect(rejected.allowed).toBe(false)
    expect(rejected.allowed ? '' : rejected.message).toContain('SELECT')
  })
})

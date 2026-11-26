import { describe, expect, it } from 'vitest'

import { classifyAthenaQuery } from '../athena-query.js'
import { explains } from '../../../tests/_helpers/explains.js'

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
  it.each(ALLOWED)('参照クエリ %j は、許可する', async (query) => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`EXPLAIN` などで始まる参照クエリを渡した場合に、`allowed` が真の結果を返すことを確認します。')
    expect(classifyAthenaQuery(query)).toEqual({ allowed: true })
  })

  it.each(NOT_READ_ONLY)('変更系クエリ %j は、理由を not-read-only として拒否する', async (query) => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`INSERT`、`DELETE`、`CREATE TABLE AS`、`UNLOAD` などデータやテーブルを変更するクエリを渡した場合に、理由が `not-read-only` の拒否を返すことを確認します。')
    expect(classifyAthenaQuery(query)).toMatchObject({ allowed: false, reason: 'not-read-only' })
  })

  it('複数の文からなるクエリは、理由を multi-statement として拒否する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`SELECT 1; DROP TABLE orders` のように `;` で複数の文をつないだクエリを渡した場合に、理由が `multi-statement` の拒否を返すことを確認します。')
    expect(classifyAthenaQuery('SELECT 1; DROP TABLE orders'))
      .toMatchObject({ allowed: false, reason: 'multi-statement' })
  })

  it('1 文目が空でも、; の後ろに文があれば、理由を multi-statement として拒否する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`; SELECT 1` のように先頭の文が空で、`;` の後ろに文があるクエリを渡した場合に、理由が `multi-statement` の拒否を返すことを確認します。')
    expect(classifyAthenaQuery('; SELECT 1'))
      .toMatchObject({ allowed: false, reason: 'multi-statement' })
  })

  it('空のクエリは、理由を empty として拒否する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。空文字、空白と改行だけ、コメントだけのクエリを渡した場合に、理由が `empty` の拒否を返すことを確認します。')
    expect(classifyAthenaQuery('')).toMatchObject({ allowed: false, reason: 'empty' })
    expect(classifyAthenaQuery('   \n  ')).toMatchObject({ allowed: false, reason: 'empty' })
    expect(classifyAthenaQuery('-- コメントだけ')).toMatchObject({ allowed: false, reason: 'empty' })
  })

  it('文字列リテラルの中の ; は、文の区切りとして扱わない', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`SELECT \';\'` のように `;` を文字列リテラルの中に含むクエリを渡した場合に、1 つの文として許可することを確認します。')
    expect(classifyAthenaQuery('SELECT \';\'')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('SELECT \'a; DROP TABLE t\' FROM orders')).toEqual({ allowed: true })
  })

  it('引用符で囲んだ識別子の中の ; は、文の区切りとして扱わない', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`SELECT "col;name" FROM orders` のように `;` を二重引用符で囲んだ識別子の中に含むクエリを渡した場合に、1 つの文として許可することを確認します。')
    expect(classifyAthenaQuery('SELECT "col;name" FROM orders')).toEqual({ allowed: true })
  })

  it('文字列リテラルの中の -- と /* は、コメントの開始として扱わない', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`SELECT \'-- x\' FROM orders` のようにコメントの開始記号を文字列リテラルの中に含むクエリを渡した場合に、許可することを確認します。')
    expect(classifyAthenaQuery('SELECT \'-- x\' FROM orders')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('SELECT \'/* x\' FROM orders')).toEqual({ allowed: true })
  })

  it('引用符を 2 つ重ねたエスケープは、リテラルの途中として扱い、閉じたことにしない', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`\'it\'\'s; ok\'` のように引用符を 2 つ重ねたリテラルを渡した場合に、その後ろの `;` を区切りとせず、許可することを確認します。')
    // Trino のエスケープは引用符の 2 重化のみ。'' の後も同じリテラルが続く。
    expect(classifyAthenaQuery('SELECT \'it\'\'s; ok\' FROM orders')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('SELECT "a""b" FROM orders')).toEqual({ allowed: true })
  })

  it('バックスラッシュは、リテラルを閉じるエスケープとして扱わない', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。バックスラッシュが通常の文字である Trino では、`\'\\\'; DROP TABLE t --\'` のクエリが `multi-statement` として拒否されることを確認します。')
    // Trino では \ は普通の文字なので 'X'; の ; はリテラル外にある = 複文。
    expect(classifyAthenaQuery(String.raw`SELECT '\'; DROP TABLE t --'`))
      .toMatchObject({ allowed: false, reason: 'multi-statement' })
  })

  it('閉じていないリテラルやコメントを含むクエリは、理由を unterminated として拒否する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。引用符やコメントが閉じていないクエリを渡した場合に、変更系とは別の理由 `unterminated` で拒否し、メッセージに `not closed` を含めることを確認します。')
    // 変更系とは別 reason にする。reason だけを見る呼び出し元が「変更系だから拒否」と誤読しない。
    expect(classifyAthenaQuery('SELECT \'abc')).toMatchObject({ allowed: false, reason: 'unterminated' })
    expect(classifyAthenaQuery('SELECT "abc')).toMatchObject({ allowed: false, reason: 'unterminated' })
    expect(classifyAthenaQuery('/* 閉じていない SELECT 1'))
      .toMatchObject({ allowed: false, reason: 'unterminated' })

    const rejected = classifyAthenaQuery('SELECT \'abc')
    expect(rejected.allowed ? '' : rejected.message).toContain('not closed')
  })

  it('EXPLAIN の修飾語とオプションを取り除き、内側のクエリで判定する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`EXPLAIN ANALYZE` や `EXPLAIN (TYPE DISTRIBUTED)` のように修飾語やオプションが付いた参照クエリを渡した場合に、許可することを確認します。')
    expect(classifyAthenaQuery('EXPLAIN ANALYZE SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN ANALYZE VERBOSE SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN VERBOSE ANALYZE SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN (TYPE DISTRIBUTED) SELECT 1')).toEqual({ allowed: true })
    expect(classifyAthenaQuery('EXPLAIN (TYPE LOGICAL, FORMAT (TEXT)) SELECT 1')).toEqual({ allowed: true })
  })

  it('EXPLAIN のオプションの括弧が閉じていないときは、理由を not-read-only として拒否する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`EXPLAIN (TYPE DISTRIBUTED SELECT 1` のようにオプションの括弧が閉じていないクエリを渡した場合に、理由が `not-read-only` の拒否を返すことを確認します。')
    expect(classifyAthenaQuery('EXPLAIN (TYPE DISTRIBUTED SELECT 1'))
      .toMatchObject({ allowed: false, reason: 'not-read-only' })
  })

  it('EXPLAIN の内側が変更系のクエリ、または空のときは、理由を not-read-only として拒否する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`EXPLAIN (TYPE DISTRIBUTED) DROP TABLE orders` などは、`not-read-only` として拒否されることを確認します。')
    expect(classifyAthenaQuery('EXPLAIN (TYPE DISTRIBUTED) DROP TABLE orders'))
      .toMatchObject({ allowed: false, reason: 'not-read-only' })
    expect(classifyAthenaQuery('EXPLAIN')).toMatchObject({ allowed: false, reason: 'not-read-only' })
  })

  it('EXPLAIN を 20000 回重ねたクエリでも、スタックを溢れさせずに判定する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`EXPLAIN` を 20000 回重ねて `SELECT 1` を続けたクエリを渡した場合に、`RangeError` が発生せず、許可を返すことを確認します。')
    // 1 段 1 再帰の実装だと RangeError になり、設計した失敗種別の外へ例外が抜ける。
    const query = `${'EXPLAIN '.repeat(20_000)}SELECT 1`

    expect(classifyAthenaQuery(query)).toEqual({ allowed: true })
  })

  it('末尾に ; が 1 つだけあるクエリは、1 つの文として許可する', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`SELECT 1 ;` の後ろに空白と改行だけが続くクエリを渡した場合に、複数の文とみなさず、許可することを確認します。')
    expect(classifyAthenaQuery('SELECT 1 ;  \n ')).toEqual({ allowed: true })
  })

  it('クエリを拒否するときは、再試行の手掛かりになる message を返す', async () => {
    await explains('Athena のクエリが参照専用かを判定する `classifyAthenaQuery` のテストです。`DROP TABLE orders` を渡して拒否された場合に、結果の `message` に、使えるクエリの例として `SELECT` が含まれることを確認します。')
    const rejected = classifyAthenaQuery('DROP TABLE orders')

    expect(rejected.allowed).toBe(false)
    expect(rejected.allowed ? '' : rejected.message).toContain('SELECT')
  })
})

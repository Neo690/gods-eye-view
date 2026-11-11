// src/layers/insider/records.test.mjs
// Pure parsing and mapping — no viewer, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INSIDER_FILINGS,
  normalizeInsiderPayload,
  parseSecAtomFeed,
} from './records.js';
import { filingLabel, isAmendment, mapAnalystRecord } from './model.js';

const FEED = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Latest Filings - Wed, 11 Nov 2026 13:29:54 EST</title>
<updated>2026-11-11T13:29:54-05:00</updated>
<entry>
<title>4 - LanzaTech Global, Inc. (0001843724) (Issuer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1843724/1/2-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-11-10 &lt;b&gt;AccNo:&lt;/b&gt; 0001193125-26-456010 &lt;b&gt;Size:&lt;/b&gt; 6 KB
</summary>
<updated>2026-11-10T21:59:02-05:00</updated>
<id>urn:tag:sec.gov,2008:accession-number=0001193125-26-456010</id>
</entry>
<entry>
<title>4 - KHOSLA VINOD (0001032453) (Reporting)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1032453/1/2-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-11-10 &lt;b&gt;AccNo:&lt;/b&gt; 0001193125-26-456010 &lt;b&gt;Size:&lt;/b&gt; 6 KB
</summary>
<updated>2026-11-10T21:59:02-05:00</updated>
<id>urn:tag:sec.gov,2008:accession-number=0001193125-26-456010</id>
</entry>
<entry>
<title>4/A - Newton Golf Company, Inc. (0001934245) (Issuer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1934245/3/4-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-11-09 &lt;b&gt;AccNo:&lt;/b&gt; 0001493152-26-051085 &lt;b&gt;Size:&lt;/b&gt; 4 KB
</summary>
<updated>2026-11-09T21:56:20-05:00</updated>
<id>urn:tag:sec.gov,2008:accession-number=0001493152-26-051085</id>
</entry>
</feed>`;

test('sec feed: the issuer and reporting entries collapse into one filing', () => {
  const { rows } = parseSecAtomFeed(FEED);
  assert.equal(rows.length, 2);
  const [first] = rows;
  assert.equal(first.id, '0001193125-26-456010');
  assert.equal(first.company, 'LanzaTech Global, Inc.');
  assert.equal(first.insider, 'KHOSLA VINOD');
  assert.equal(first.issuerCik, '0001843724');
  assert.equal(first.insiderCik, '0001032453');
  assert.equal(first.formType, '4');
  assert.equal(first.filedDay, '2026-11-10');
  assert.equal(first.filedAt, Date.parse('2026-11-10T21:59:02-05:00'));
  assert.match(first.filingUrl, /sec\.gov/);
});

test('sec feed: newest filing first and amendments flagged', () => {
  const { rows } = parseSecAtomFeed(FEED);
  assert.equal(rows[0].formType, '4');
  assert.equal(rows[1].formType, '4/A');
  assert.ok(rows[0].filedAt > rows[1].filedAt);
  assert.equal(isAmendment(rows[1].formType), true);
  assert.equal(isAmendment(rows[0].formType), false);
});

test('sec feed: a lone entry keeps one side and leaves the other null', () => {
  const solo = FEED.replace(/<entry>[\s\S]*?<\/entry>/, '');
  const { rows } = parseSecAtomFeed(solo);
  assert.equal(rows.length, 2);
  const owner = rows.find((row) => row.id === '0001193125-26-456010');
  assert.equal(owner.insider, 'KHOSLA VINOD');
  assert.equal(owner.company, null);
});

test('sec feed: non-Atom input fails instead of reporting an empty world', () => {
  assert.equal(parseSecAtomFeed('<html><body>error</body></html>'), null);
  assert.equal(parseSecAtomFeed(null), null);
  assert.deepEqual(parseSecAtomFeed('<feed></feed>').rows, []);
});

test('sec feed: entries without a parseable headline are skipped', () => {
  const broken = FEED.replace(
    '4 - LanzaTech Global, Inc. (0001843724) (Issuer)',
    'garbage without a cik',
  );
  const { rows } = parseSecAtomFeed(broken);
  assert.equal(
    rows.some((row) => row.company === 'LanzaTech Global, Inc.'),
    false,
  );
});

test('proxy payload: validates rows and rejects a non-list', () => {
  const { rows } = parseSecAtomFeed(FEED);
  const validated = normalizeInsiderPayload({ rows });
  assert.equal(validated.length, 2);
  assert.equal(normalizeInsiderPayload({ rows: 'nope' }), null);
  assert.equal(normalizeInsiderPayload(null), null);
  assert.deepEqual(normalizeInsiderPayload({ rows: [] }), []);
});

test('proxy payload: rows without an id are dropped, not fatal', () => {
  const validated = normalizeInsiderPayload({
    rows: [{ id: '  ' }, { id: 'A-1', company: 'X' }],
  });
  assert.equal(validated.length, 1);
  assert.equal(validated[0].id, 'A-1');
});

test('analyst record: fields map, missing becomes null, id falls back', () => {
  const record = mapAnalystRecord(
    { id: 'A-1', formType: '4', company: 'X', insider: 'Y', filedAt: 5 },
    2,
  );
  assert.equal(record.id, 'A-1');
  assert.equal(record.company, 'X');
  assert.equal(record.filedAt, 5);
  assert.equal(record.filedDay, null);
  assert.equal(record.amendment, false);
  const fallback = mapAnalystRecord({}, 2);
  assert.equal(fallback.id, 'INSIDER-0002');
  for (const value of Object.values(fallback)) {
    assert.notEqual(value, undefined);
  }
});

test('label: missing sides stay readable', () => {
  assert.equal(
    filingLabel({ company: 'ACME', insider: 'J DOE' }),
    'ACME — J DOE',
  );
  assert.equal(filingLabel({}), 'Unknown issuer — Unknown reporting owner');
});

test('row count is capped', () => {
  const many = Array.from(
    { length: MAX_INSIDER_FILINGS + 10 }, // EDGAR accessions and CIKs are numeric: a non-numeric id would be skipped
    // for the wrong reason and the cap assertion would pass vacuously.
    (_, i) =>
      `<entry><title>4 - C${i} (${1000000000 + i}) (Issuer)</title><link href="u"/><summary>Filed: 2026-11-10</summary><updated>2026-11-10T00:00:00Z</updated><id>urn:tag:sec.gov,2008:accession-number=${4100000000000 + i}</id></entry>`,
  ).join('');
  const { rows } = parseSecAtomFeed(
    `<feed><updated>2026-11-11T00:00:00Z</updated>${many}</feed>`,
  );
  assert.equal(rows.length, MAX_INSIDER_FILINGS);
});

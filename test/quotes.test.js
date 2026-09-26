const test = require('node:test');
const assert = require('node:assert/strict');
const { collapseHtmlQuotes, collapseMarkdownQuotes, quoteFallback } = require('../src/utils/quotes');

test('HTML quotes collapse once, except inside closed disclosures or code', () => {
  const source = '<blockquote>A</blockquote><details><summary>Расшифровка</summary><blockquote expandable>B</blockquote></details>'
    + '<details open><blockquote>C</blockquote></details><pre><code>&lt;blockquote&gt;D</code></pre>';
  const result = collapseHtmlQuotes(source);
  assert.match(result, /^<blockquote expandable>A/);
  assert.match(result, /<\/summary><blockquote>B/);
  assert.match(result, /<details open><blockquote expandable>C/);
  assert.match(result, /<pre><code>&lt;blockquote&gt;D/);
  assert.equal(collapseHtmlQuotes(result), result);
});

test('Markdown quotes preserve formatting and lazy continuation; code and other blocks stay unchanged', () => {
  const source = 'Intro\n\n> **important**\ncontinued\n\n```html\n<blockquote>example</blockquote>\n> code\n```\n\n`<blockquote>`\n\n||spoiler||';
  const result = collapseMarkdownQuotes(source);
  assert.match(result, /<blockquote expandable>\n<p><strong>important<\/strong><br>\ncontinued/);
  assert.ok(result.endsWith('```html\n<blockquote>example</blockquote>\n> code\n```\n\n`<blockquote>`\n\n||spoiler||'));
  assert.equal(collapseMarkdownQuotes(result), result);
  assert.match(collapseMarkdownQuotes('- Item\n  > Quote'), /<blockquote expandable>/);
  assert.equal((collapseMarkdownQuotes('> outer\n>> inner').match(/expandable/g) || []).length, 1);
});

test('raw HTML disclosure stays one click, including Markdown quotes inside it', () => {
  const source = '<details>\n<summary>Расшифровка</summary>\n\n> full text\n\n<blockquote>another quote</blockquote>\n</details>';
  assert.doesNotMatch(collapseMarkdownQuotes(source), /expandable/);
});

test('legacy fallback preserves the complete transcript, UTF-16 offsets and delivery-sized chunks', () => {
  const transcript = '😀 & важный текст '.repeat(600);
  const chunks = quoteFallback({ html: '<p>🎙 Имя</p><p>Кратко: тема</p><details><summary>Расшифровка</summary><blockquote>'
    + transcript.replaceAll('&', '&amp;') + '</blockquote></details>' });
  assert.equal(chunks.map(c => c.text).join(''), '🎙 Имя\nКратко: тема\nРасшифровка\n' + transcript.trimEnd());
  const quoted = chunks.flatMap(chunk => chunk.entities.map(e => {
    assert.equal(e.type, 'expandable_blockquote');
    assert.ok(e.offset >= 0 && e.offset + e.length <= chunk.text.length);
    return chunk.text.slice(e.offset, e.offset + e.length);
  })).join('');
  assert.equal(quoted, transcript.trimEnd());
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 4000);
    assert.doesNotMatch(chunk.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
  assert.equal(quoteFallback({ html: '<p>just text</p>' }), null);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const MarkdownIt = require('markdown-it');
const { research, renderFoundSources, conservativeAnswer } = require('../src/services/research');
const { collapseMarkdownQuotes, quoteFallback } = require('../src/utils/quotes');

const empty = { claims: [], sufficient: false, followUpQuery: 'second query' };
const row = (n, extra = {}) => ({ url: `https://platform.example.org/item-${n}`, title: `Material ${n}`, content: 'Unverified provider snippet.', ...extra });

test('all unique public materials survive two rounds, bounded review packs and a failed verifier', async () => {
  let searches = 0, reviews = 0;
  const packs = [];
  const distinct = await research({ question: 'Find relevant material', plan: { searchQuery: 'first query' },
    search: async () => { const start = searches++ * 12; return Array.from({ length: 12 }, (_, n) => row(start + n)); },
    read: async () => 'Read page text. '.repeat(600),
    review: async prompt => { packs.push(JSON.parse(prompt.split('ИСТОЧНИКИ: ')[1]));
      if (++reviews === 1) return empty; throw Error('SECRET_PROVIDER_PAYLOAD'); },
  });
  assert.equal(distinct.foundSources.length, 24);
  assert.equal(distinct.sources.length, 16);
  assert.equal(distinct.verificationFailed, true);
  assert.equal(distinct.claims.length, 0);
  assert.ok(packs.every(pack => pack.length <= 16));
  assert.ok(packs.every(pack => pack.reduce((n, item) => n + (item.pageText || item.snippet || '').length, 0) <= 32000));
  assert.ok(distinct.foundSources.every(item => !('snippet' in item) && !('pageText' in item)));
  const rendered = conservativeAnswer(distinct);
  for (let n = 0; n < 24; n++) assert.ok(rendered.includes(row(n).url));
  assert.doesNotMatch(rendered, /SECRET_PROVIDER_PAYLOAD|Unverified provider snippet/);
});

test('source-only mode returns found URLs without reading or reviewing search results', async () => {
  let searches = 0, reviews = 0;
  const reads = [];
  const result = await research({ question: 'Give links', plan: { searchQuery: 'links', output: 'sources' },
    search: async () => { searches++; return [row(0), row(0, { url: row(0).url + '#duplicate' }),
      row(1, { level: 'provider_report' }), row(2), row(3), row(4, { url: 'http://localhost/private' })]; },
    read: async url => { reads.push(url); return url === row(0).url ? 'Actual page text.' : null; },
    review: async () => { reviews++; throw Error('must not call'); },
  });
  assert.equal(searches, 1); assert.equal(reviews, 0); assert.equal(result.reviewAttempts, 0);
  assert.equal(reads.length, 0); assert.equal(result.foundSources.length, 4);
  assert.equal(result.foundSources[0].level, 'snippet'); assert.equal(result.foundSources[0].readStatus, 'unread');
  assert.equal(result.foundSources[1].level, 'provider_report'); assert.equal(result.foundSources[1].readStatus, 'unread');
  assert.equal(result.foundSources[3].readStatus, 'unread');
  assert.equal(result.claims.length, 0); assert.equal(result.verificationFailed, false);
});

test('empty source-only round retries once while strict platform and explicitly requested period survive', async () => {
  const searches = [], reads = [];
  const result = await research({ question: 'This week on this platform', plan: { searchQuery: 'platform', output: 'sources',
    requiredDomains: ['platform.example.org'], requiredTimeRange: 'week', timeRange: 'day' },
    search: async (query, options) => { searches.push(options); return searches.length === 1
      ? [row(0, { url: 'https://platform.example.org.attacker.com/item' })] : [row(1), row(2, { url: 'https://www.platform.example.org/item' })]; },
    read: async url => { reads.push(url); return 'Page text'; }, review: async () => { throw Error('must not call'); },
  });
  assert.equal(searches.length, 2);
  assert.ok(searches.every(options => options.timeRange === 'week'));
  assert.ok(searches.every(options => options.requiredDomains.includes('platform.example.org')));
  assert.equal(reads.length, 0); assert.equal(result.foundSources.length, 2);
  assert.ok(result.foundSources.every(source => !source.url.includes('attacker')));
});

test('a null required period preserves the initial soft date filter and clears it on follow-up', async () => {
  const searches = [];
  await research({ question: 'Find recent material', plan: { searchQuery: 'first query', timeRange: 'day', requiredTimeRange: null },
    search: async (query, options) => { searches.push(options); return [row(searches.length)]; },
    read: async () => 'Page text.', review: async () => empty });
  assert.equal(searches.length, 2);
  assert.equal(searches[0].timeRange, 'day');
  assert.equal(searches[1].timeRange, undefined);
});

test('strict scope excludes an explicit outside URL from conclusions but preserves its coverage and link', async () => {
  const outside = 'https://outside.example.org/supplied', reads = [], packs = [];
  const result = await research({ question: 'Verify on platform', plan: { searchQuery: 'platform', requiredDomains: ['platform.example.org'] },
    suppliedUrls: [outside], search: async () => [row(1)], read: async url => { reads.push(url); return 'Actual page text.'; },
    review: async prompt => { packs.push(prompt); return { ...empty, addressesQuestion: true, followUpQuery: '' }; },
  });
  assert.equal(result.requestedSources[0].status, 'out_of_scope');
  assert.ok(!reads.includes(outside));
  assert.ok(packs.every(prompt => !JSON.parse(prompt.split('ИСТОЧНИКИ: ')[1]).some(item => item.url === outside)));
  assert.ok(conservativeAnswer(result).includes(outside));
  assert.match(renderFoundSources(result), /вне указанной площадки/);
});

test('the full original link list survives the supplied read and review coverage limits without AI review', async () => {
  let reviews = 0;
  const suppliedUrls = Array.from({ length: 35 }, (_, n) => `https://example.org/original-${n}`);
  const result = await research({ question: 'Give links', plan: { output: 'sources' }, suppliedUrls,
    search: async () => [], read: async () => null, review: async () => { reviews++; return empty; } });
  assert.equal(reviews, 0); assert.equal(result.requestedSources.length, 32); assert.equal(result.omittedSourceCount, 3);
  assert.equal(result.foundSources.length, 35);
  const text = conservativeAnswer(result);
  for (const url of suppliedUrls) assert.ok(text.includes(url));
  assert.match(text, /Не удалось прочитать/);
});

test('sources use a titled closed or open disclosure and escape all user-visible text', () => {
  const title = '<script>SECRET</script> [click](https://attacker.com) ![image](https://attacker.com/p) **bold**\n> injected\u202e';
  const url = 'https://example.org/path(foo)?q=[])<img';
  const result = { foundSources: [
    { url, title, level: 'snippet', readStatus: 'unread' },
    { url: 'https://example.org/second', title: 'x'.repeat(10000), level: 'page', readStatus: 'read' },
    { url: 'javascript:alert(1)', title: 'forbidden' }, { url: 'http://127.0.0.1/', title: 'forbidden' },
  ] };
  const text = renderFoundSources(result);
  const html = new MarkdownIt({ html: true }).render(collapseMarkdownQuotes('Ответ\n\n' + text));
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.doesNotMatch(html, /<script>|<img|href="https:\/\/attacker|\u202e|!\[|\[click\]|\*\*bold/);
  assert.match(html, /<details><summary>Источники<\/summary>/);
  assert.doesNotMatch(html, /Найденные материалы|поисковая выдержка|текст страницы прочитан/);
  assert.ok(text.length < 1500);
  const open = renderFoundSources(result, { open: true, intro: 'Ссылки <img src="x"> & всё.' });
  assert.match(open, /<details open><summary>Источники<\/summary><p>Ссылки &lt;img src&#61;&quot;x&quot;&gt; &amp; всё\.<\/p>/);
  assert.doesNotMatch(open, /<img /);
  const [closedLegacy] = quoteFallback({ markdown: text });
  assert.ok(closedLegacy.entities.some(entity => entity.type === 'expandable_blockquote'));
  const [openLegacy] = quoteFallback({ markdown: open });
  assert.ok(openLegacy.text.includes('Ссылки <img src="x"> & всё.'));
  assert.equal(openLegacy.entities.filter(entity => entity.type === 'text_link').length, 2);
  assert.ok(!openLegacy.entities.some(entity => entity.type === 'expandable_blockquote'));
  assert.equal(renderFoundSources({ foundSources: [] }), '');
});

test('found materials never replace the actual reason for failed verification or publish a raw draft', () => {
  for (const auditFailure of ['timeout', 'unavailable', 'invalid', 'rejected']) {
    const result = { foundSources: [{ ...row(0), level: 'snippet', readStatus: 'unread' }],
      claims: [{ claim: 'SECRET_INVALID_CLAIM' }], answer: 'SECRET_RAW_DRAFT', fallbackStage: 'answer_audit', auditFailure };
    const text = conservativeAnswer(result);
    assert.ok(text.includes(row(0).url));
    assert.doesNotMatch(text, /SECRET_|Unverified provider snippet/);
    if (auditFailure === 'timeout') assert.match(text, /дождаться/);
    if (auditFailure === 'rejected') assert.match(text, /не подтвердила выводы/);
  }
});

test('large open and closed source lists retain all long destinations across legacy chunks', () => {
  const foundSources = Array.from({ length: 40 }, (_, n) => ({ url: `https://example.org/${n}/${'x'.repeat(1800)}`,
    title: `${n}: ${'title '.repeat(40)}`, level: 'snippet', readStatus: 'unread' }));
  for (const open of [false, true]) {
    const text = renderFoundSources({ foundSources }, { open });
    assert.ok(text.length > 30000);
    const chunks = quoteFallback({ markdown: text });
    assert.ok(chunks.length > 1);
    const urls = new Set(chunks.flatMap(chunk => chunk.entities.filter(entity => entity.type === 'text_link').map(entity => entity.url)));
    assert.deepEqual(urls, new Set(foundSources.map(source => source.url)));
    assert.ok(chunks.every(chunk => chunk.text.length <= 4000));
    assert.equal(chunks.some(chunk => chunk.entities.some(entity => entity.type === 'expandable_blockquote')), !open);
  }
});

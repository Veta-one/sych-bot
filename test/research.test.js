const assert = require('node:assert/strict');
const test = require('node:test');
const { pageExcerpt, publicUrl, normalizeSources, validateReview, research, evidenceContext, hasOnlyEvidenceLinks, conservativeAnswer, citedProviderSources } = require('../src/services/research');

const page = '# Claude.ai\nSupported countries: Kazakhstan, Armenia, Georgia.\nPayments depend on the card issuer.';
const source = { id: 'S1', url: 'https://example.org/countries', title: 'Supported countries', pageText: page, level: 'page' };
const claim = { claim: 'Kazakhstan is supported for Claude.ai.', status: 'supported', sourceId: 'S1', quote: 'Supported countries: Kazakhstan, Armenia, Georgia.', limitation: 'Does not establish payment acceptance.' };

test('only actual retrieved quotes and source IDs may support a claim', () => {
  const result = validateReview({ claims: [claim, { ...claim, sourceId: 'invented' }, { ...claim, quote: 'All Kazakhstan cards are accepted.' }], sufficient: true }, [source]);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].url, source.url);
  assert.equal(result.sufficient, false);
  assert.match(result.gaps.join(' '), /отброшена/);
});

test('list entries can be short quotes, but a heading alone is not proof of membership', () => {
  assert.equal(validateReview({ claims: [{ ...claim, quote: 'Kazakhstan' }] }, [source]).claims.length, 1);
  assert.equal(validateReview({ claims: [{ ...claim, quote: 'Supported countries:' }] }, [source]).claims.length, 0);
});

test('provider prose and snippets cannot be promoted to directly verified facts', () => {
  for (const level of ['snippet', 'provider_report']) {
    const result = validateReview({ claims: [claim], sufficient: true }, [{ ...source, pageText: undefined, snippet: page, level }]);
    assert.equal(result.claims[0].status, 'reported');
  }
});

test('partial documents are marked and relevant content past 6000 chars survives', () => {
  const full = 'navigation '.repeat(5000) + '\nKazakhstan is supported for Claude.ai.\n';
  const excerpt = pageExcerpt(full, 'Claude Kazakhstan');
  assert.equal(excerpt.truncated, true);
  assert.match(excerpt.text, /Kazakhstan is supported/);
  assert.ok(excerpt.text.length <= 24000);
  assert.equal(pageExcerpt(page, 'Kazakhstan').truncated, false);
});

test('URLs must come from public HTTP sources; malformed results are tolerated', () => {
  for (const url of ['file:///data', 'http://127.0.0.1/a', 'http://2130706433/', 'http://[::1]/', 'http://localhost/a', 'https://a:b@example.org/', 'javascript:alert(1)']) assert.equal(publicUrl(url), null);
  assert.equal(normalizeSources(null).length, 0);
  assert.equal(normalizeSources([{ url: source.url }, { url: source.url + '#same' }]).length, 1);
});

test('research reads official source first, keeps limitations and omits generated search answers', async () => {
  const reads = [];
  const result = await research({ question: 'Are subscriptions available in Kazakhstan?',
    plan: { searchQuery: 'Claude countries', preferredDomains: ['example.org'] },
    search: async () => [{ url: 'https://social.example.com/post', content: 'They declined my card.' }, { url: source.url, title: source.title, content: 'Countries' }],
    read: async url => { reads.push(url); return url === source.url ? page : 'They declined my card.'; },
    review: async prompt => {
      assert.match(prompt, /ДОСЛОВНУЮ/);
      return { claims: [{ ...claim, sourceId: 'S2' }], gaps: ['Specific card acceptance not established.'], sufficient: true };
    },
  });
  assert.equal(reads[0], source.url);
  assert.equal(result.claims[0].status, 'supported');
  const context = evidenceContext(result);
  assert.match(context, /Does not establish payment acceptance/);
  assert.match(context, /Specific card acceptance not established/);
  assert.doesNotMatch(context, /They declined my card/);
});

test('weak evidence triggers at most one targeted follow-up without stale news filters', async () => {
  const queries = [];
  let reviews = 0;
  const result = await research({ question: 'Verify the policy', plan: { searchQuery: 'rumor', topic: 'news', timeRange: 'day', preferredDomains: ['example.org'] },
    search: async (q, opts) => { queries.push({ q, opts }); return [{ url: source.url, content: page }]; },
    read: async () => page,
    review: async () => { reviews++; return { claims: [claim], sufficient: false, gaps: ['Need context'], followUpQuery: 'official policy' }; },
  });
  assert.equal(queries.length, 2);
  assert.equal(queries[1].q, 'official policy');
  assert.equal(queries[1].opts.timeRange, undefined);
  assert.deepEqual(queries[1].opts.preferredDomains, ['example.org']);
  assert.equal(reviews, 2);
  assert.equal(result.sufficient, false);
});

test('search, extraction, invalid review and deadline failures never become factual evidence', async () => {
  const cases = [
    { search: async () => { throw Error('offline'); }, read: async () => page, review: async () => null },
    { search: async () => [], read: async () => page, review: async () => { throw Error('must not run'); } },
    { search: async () => [{ url: source.url, content: 'Unrelated material about the region.' }], read: async () => { throw Error('unreadable'); }, review: async () => ({ claims: [claim], sufficient: true }) },
    { search: async () => new Promise(() => {}), read: async () => page, review: async () => null, budgetMs: 15 },
  ];
  for (const callbacks of cases) {
    const result = await research({ question: 'Verify', plan: { searchQuery: 'specific event' }, ...callbacks });
    assert.equal(result.claims.length, 0);
    assert.equal(result.sufficient, false);
    assert.match(evidenceContext(result), /не удалось подтвердить/);
  }
});

test('images are exposed only when explicitly requested', async () => {
  for (const includeImages of [false, true]) {
    const result = await research({ question: 'example', plan: { searchQuery: 'example', includeImages },
      search: async () => [{ url: source.url, content: page, imageUrls: ['https://example.org/photo.jpg'] }],
      read: async () => page, review: async () => ({ claims: [claim], sufficient: true }),
    });
    assert.equal(result.imageUrls.length, includeImages ? 1 : 0);
  }
});

test('citation validation handles parentheses and rejects foreign URLs', () => {
  const result = { claims: [{ url: 'https://example.org/Policy_(service)' }] };
  assert.equal(hasOnlyEvidenceLinks('[Policy](https://example.org/Policy_(service))', result), true);
  assert.equal(hasOnlyEvidenceLinks('[Policy](https://unrelated.org/Policy_(service))', result), false);
  assert.equal(hasOnlyEvidenceLinks('Trust me, no citation.', result), false);
});

test('failed auditing never publishes intermediate model conclusions', () => {
  const text = conservativeAnswer({ claims: [{ ...claim, url: source.url, status: 'contradicted' }], gaps: [] });
  assert.match(text, /Проверку ответа завершить не удалось/);
  assert.doesNotMatch(text, /Kazakhstan/);
});

test('provider statements are attached to their citations, not to every URL', () => {
  const sources = citedProviderSources('Kazakhstan is listed [1]. Card acceptance is unknown [2].', ['https://example.org/countries', 'https://example.org/payment']);
  assert.equal(sources.length, 2);
  assert.match(sources[0].content, /Kazakhstan/);
  assert.doesNotMatch(sources[0].content, /Card acceptance/);
  assert.match(sources[1].content, /Card acceptance/);
  assert.doesNotMatch(sources[1].content, /Kazakhstan/);
  assert.equal(citedProviderSources('Unsupported provider prose', ['https://example.org/']).length, 0);
});

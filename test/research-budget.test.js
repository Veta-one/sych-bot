const assert = require('node:assert/strict');
const test = require('node:test');
const { research, conservativeAnswer, validateReview, boundedSources, publicUrl,
  boundedQuestion, REVIEW_TIMEOUT_MS, RESEARCH_TIMEOUT_MS } = require('../src/services/research');

test('a short recheck retains the original question at the end of a long source post', () => {
  const { buildSourceContext } = require('../src/utils/source-context');
  const sourceContext = buildSourceContext({ text: 'Сыч, проверь ссылки и объясни локальный запуск с OpenClaw',
    from: { id: 1 }, reply_to_message: { from: { id: 2 }, caption: 'Пост о движке памяти. ' + 'Описание '.repeat(1200) } });
  assert.match(sourceContext.text, /OpenClaw/);
  const question = boundedQuestion(JSON.stringify({ request: 'Сыч, ты уверен?', reply: sourceContext.text,
    history: 'Recent discussion '.repeat(200), suppliedMaterial: '' }));
  assert.ok(question.length <= 8000);
  assert.match(JSON.parse(question).reply, /локальный запуск с OpenClaw/);
});

const fact = 'Getty licensed this archive for editorial use.';
const supported = { claims: [{ claim: fact, status: 'supported', sourceId: 'S1', quote: fact }], sufficient: true };
const empty = { claims: [], sufficient: false, gaps: ['No evidence for the specific claim.'], followUpQuery: '' };
const base = {
  question: 'Getty archive licensing', plan: { searchQuery: 'Getty archive licensing' },
  search: async () => [{ url: 'https://example.org/archive', content: fact }],
  read: async () => fact,
};
const promptSources = prompt => JSON.parse(prompt.split('ИСТОЧНИКИ: ')[1]);
const bodyChars = sources => sources.reduce((sum, source) => sum + (source.pageText || '').length + (source.snippet || '').length, 0);
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

test('source bodies across both rounds share 32k, keep late passages and omit duplicate snippets', async () => {
  const packs = [];
  let searches = 0;
  const result = await research({ ...base,
    search: async () => {
      const round = searches++;
      return Array.from({ length: 8 }, (_, i) => ({ url: `https://example.org/${round}-${i}`,
        content: `${fact}\n${'snippet '.repeat(1000)}` }));
    },
    read: async () => `${'navigation '.repeat(7000)}\n${fact}\n`,
    review: async prompt => {
      const pack = promptSources(prompt); packs.push(pack);
      return { ...empty, followUpQuery: packs.length === 1 ? 'Getty archive primary statement' : '' };
    },
  });
  assert.equal(packs.length, 2);
  for (const pack of packs) {
    assert.ok(bodyChars(pack) <= 32000, `source body exceeded 32k: ${bodyChars(pack)}`);
    for (const row of pack) {
      if (row.level === 'page') {
        assert.ok(row.pageText.length <= 6000);
        assert.ok(!row.snippet, 'read pages must not duplicate the search snippet');
        assert.match(row.pageText, /Getty licensed this archive/);
        assert.equal(row.truncated, true);
      } else assert.ok(row.snippet.length <= 1000);
    }
  }
  assert.ok(bodyChars(result.sources) <= 32000);
});

test('global pack limit applies when five complete pages plus eleven snippets exceed 32k', () => {
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: `S${i + 1}`, url: `https://example.org/${i}`,
    level: i < 5 ? 'page' : 'snippet', ...(i < 5 ? { pageText: 'A'.repeat(6000) } : { snippet: 'B'.repeat(1000) }) }));
  assert.equal(bodyChars(rows), 41000);
  const packed = boundedSources(rows, 'Getty archive');
  assert.ok(bodyChars(packed) <= 32000);
  assert.equal(packed.length, 16);
  assert.ok(packed.every(row => row.truncated));
  assert.equal(boundedSources([...rows, ...rows], '').length, 16);
  assert.equal(publicUrl(`https://example.org/${'x'.repeat(2100)}`), null);
});

test('question context is limited to 8k while preserving the request, reply and newest history', async () => {
  let sent;
  const question = JSON.stringify({ request: 'CURRENT_REQUEST Getty licensing', reply: 'REPLIED_QUESTION',
    history: Array.from({ length: 30 }, (_, i) => ({ text: `${i === 29 ? 'LATEST_CONTEXT' : 'old context'} ${'history '.repeat(1000)}` })),
    suppliedMaterial: 'supplied '.repeat(5000) });
  const result = await research({ ...base, question, review: async prompt => { sent = prompt; return supported; } });
  const context = JSON.parse(sent.split('ВОПРОС И КОНТЕКСТ: ')[1].split('\nИСТОЧНИКИ: ')[0]);
  assert.ok(context.length <= 8000);
  assert.match(context, /CURRENT_REQUEST/);
  assert.match(context, /REPLIED_QUESTION/);
  assert.match(context, /LATEST_CONTEXT/);
  assert.match(context, /сокращ/);
  assert.ok(result.question.length <= 8000, 'final audit must reuse the bounded question');
});

test('production string history keeps its latest lines within the same 8k context budget', async () => {
  let prompt;
  const history = Array.from({ length: 40 }, (_, index) => `user: OLD_HISTORY_${index} ${'old context '.repeat(300)}`).join('\n')
    + '\nassistant: LATEST_HISTORY_DECISION archive licensing needs verification.'
    + '\nuser: LATEST_HISTORY_QUESTION is this the same archive?';
  const question = JSON.stringify({ request: 'CURRENT_REQUEST Getty licensing', reply: 'REPLIED_QUESTION which archive?',
    history, suppliedMaterial: 'supplement '.repeat(3000) });
  const result = await research({ ...base, question, review: async value => { prompt = value; return supported; } });
  const bounded = JSON.parse(JSON.parse(prompt.split('ВОПРОС И КОНТЕКСТ: ')[1].split('\nИСТОЧНИКИ: ')[0]));
  assert.equal(typeof bounded.history, 'string', 'preserve the actual production history shape');
  assert.match(bounded.request, /CURRENT_REQUEST/);
  assert.match(bounded.reply, /REPLIED_QUESTION/);
  assert.match(bounded.history, /LATEST_HISTORY_DECISION/);
  assert.match(bounded.history, /LATEST_HISTORY_QUESTION/);
  assert.doesNotMatch(bounded.history, /OLD_HISTORY_0\b/);
  assert.match(JSON.stringify(bounded), /сокращ/);
  assert.ok(result.question.length <= 8000);
});

test('a quote hidden in the omitted page remainder cannot validate a claim', async () => {
  const hidden = 'Unrelated hidden passage grants worldwide permanent exclusive rights.';
  const result = await research({ ...base, read: async () => `${fact}\n${'navigation '.repeat(10000)}${hidden}\n${'navigation '.repeat(10000)}`,
    review: async prompt => {
      assert.doesNotMatch(prompt, /Unrelated hidden passage/);
      return { claims: [{ ...supported.claims[0], quote: hidden }], sufficient: true };
    },
  });
  assert.equal(result.claims.length, 0);
  assert.equal(result.sufficient, false);
});

test('second-round global packing invalidates quotes in the newly hidden part of an earlier complete page', async () => {
  const hidden = 'Unrelated sentence provides an entirely different observation.';
  const full = `${'navigation '.repeat(600)}${hidden}`.slice(-(6000));
  assert.equal(full.length, 6000);
  let searches = 0;
  const prompts = [];
  const result = await research({ ...base,
    search: async () => {
      const round = searches++;
      return Array.from({ length: 8 }, (_, i) => ({ url: `https://example.org/${round}-${i}`, content: 'snippet '.repeat(200) }));
    },
    read: async () => full,
    review: async prompt => {
      prompts.push(prompt);
      return prompts.length === 1 ? { ...empty, followUpQuery: 'Getty archive policy' }
        : { claims: [{ ...supported.claims[0], quote: hidden }], sufficient: true };
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Unrelated sentence provides/);
  assert.doesNotMatch(prompts[1], /Unrelated sentence provides/);
  assert.equal(result.claims.length, 0);
  assert.equal(result.sufficient, false);
});

test('null, provider failure and malformed JSON shape get one retry using identical material and no search repeat', async () => {
  for (const failed of [null, () => { const e = new Error('unsafe provider details'); e.code = 'EVIDENCE_REVIEW_UNAVAILABLE'; throw e; }, { approved: true }]) {
    let searches = 0;
    const prompts = [];
    const result = await research({ ...base, search: async (...args) => { searches++; return base.search(...args); },
      review: async prompt => { prompts.push(prompt); return prompts.length === 1 ? typeof failed === 'function' ? failed() : failed : supported; },
    });
    assert.equal(searches, 1);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1]);
    assert.equal(result.sufficient, true);
    assert.equal(result.verificationFailed, false);
    assert.equal(result.reviewAttempts, 2);
    assert.ok(result.errors.some(error => error.stage === 'review' && typeof error.code === 'string'));
    assert.doesNotMatch(JSON.stringify(result.errors), /unsafe provider details/);
  }
});

test('valid empty claims do not trigger a technical retry', async () => {
  let calls = 0;
  const result = await research({ ...base, review: async () => { calls++; return empty; } });
  assert.equal(calls, 1);
  assert.equal(result.verificationFailed, false);
});

test('technical retry is allowed only once across both research rounds', async () => {
  let calls = 0;
  const result = await research({ ...base, search: async query => [{ url: `https://example.org/${query}`, content: fact }],
    review: async () => { calls++; return calls === 2 ? { ...empty, followUpQuery: 'second' } : null; },
  });
  assert.equal(calls, 3, 'round one retries; round two has no retry allowance left');
  assert.equal(result.verificationFailed, true);
  assert.equal(result.claims.length, 0);
});

test('40s review deadline leaves one retry inside the total 90s budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const options = [];
  const pending = research({ ...base, review: async (prompt, opts) => {
    options.push(opts); return options.length === 1 ? new Promise(() => {}) : supported;
  } });
  await flush();
  assert.equal(options[0]?.timeoutMs, 40000);
  t.mock.timers.tick(40000); await flush();
  const result = await pending;
  assert.equal(options.length, 2);
  assert.equal(options[1].timeoutMs, 40000);
  assert.equal(result.sufficient, true);
  assert.equal(REVIEW_TIMEOUT_MS, 40000);
  assert.equal(RESEARCH_TIMEOUT_MS, 90000);
});

test('shared deadline caps remaining review time and stops retry when exhausted', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const options = [];
  const pending = research({ ...base, budgetMs: 50000,
    search: async () => new Promise(resolve => setTimeout(() => resolve([{ url: 'https://example.org/archive', content: fact }]), 30000)),
    review: async (prompt, opts) => { options.push(opts); return new Promise(() => {}); },
  });
  await flush(); t.mock.timers.tick(30000); await flush();
  assert.equal(options[0]?.timeoutMs, 20000);
  t.mock.timers.tick(20000); await flush();
  const result = await pending;
  assert.equal(options.length, 1);
  assert.equal(result.verificationFailed, true);
  assert.equal(result.sufficient, false);
});

test('invalid claim primitives do not crash or make an empty review sufficient', () => {
  const result = validateReview({ claims: [null, true, 7], sufficient: true }, []);
  assert.equal(result.sufficient, false);
  assert.equal(result.claims.length, 0);
});

test('conservative response distinguishes failed verification, preserves safe reading links and hides unchecked claims', () => {
  const sources = [
    { url: 'javascript:alert(1)', title: 'inject' },
    ...Array.from({ length: 4 }, (_, i) => ({ url: `https://example.org/${i}`, title: `UNVERIFIED_CLAIM_${i}` })),
  ];
  const technical = conservativeAnswer({ claims: [], sources, verificationFailed: true });
  const noEvidence = conservativeAnswer({ claims: [], sources, verificationFailed: false });
  const finalFailure = conservativeAnswer({ claims: [{ claim: 'UNVERIFIED_FINAL_FACT' }], sources, verificationFailed: true });
  assert.match(technical, /техническ/);
  assert.doesNotMatch(noEvidence, /техническ/);
  assert.match(technical, /Материалы для чтения/);
  assert.equal((technical.match(/https:\/\/example.org/g) || []).length, 3);
  for (const text of [technical, noEvidence, finalFailure]) {
    assert.doesNotMatch(text, /UNVERIFIED|javascript|[\u2014\u2015\u2e3a\u2e3b]/);
  }
});

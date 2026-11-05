const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function load(file, dependencies, runtime = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    module, Buffer, URL, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    ...runtime,
  }, { filename: file });
  return module.exports;
}

function configuration(env = {}) {
  return load('config.js', { '../package.json': { version: 'test' }, dotenv: { config() {} } },
    { process: { env: { TELEGRAM_BOT_TOKEN: '123:synthetic', AI_API_KEY: 'synthetic', ...env } } });
}

function harness({ mode = 'auto', primary = true, native = false } = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), calls = [], logs = [];
  const setTimer = (fn, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  const runtime = { Date: class extends Date { static now() { return now; } },
    setTimeout: setTimer, clearTimeout: clearTimer,
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) } };
  const asyncModule = load('utils/async.js', {}, runtime);
  const research = load('services/research.js', { '../utils/async': asyncModule, 'markdown-it': require('markdown-it') }, runtime);
  const config = { geminiKeys: [], mainModel: 'synthetic-review-model', researchReviewProvider: mode };
  const prompts = load('core/prompts.js', { '../config': config });
  const ai = load('services/ai.js', {
    '@google/generative-ai': {}, '../config': config, '../core/prompts': prompts,
    axios: {}, openai: {}, '@tavily/core': {},
    './storage': { initGoogleStats() {}, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': {}, './youtube': {}, './youtube-gemini': {}, '../utils/content-policy': {},
    './research': research, '../utils/async': asyncModule,
    '../utils/private-context': require('../src/utils/private-context'),
    '../utils/profile-evidence': require('../src/utils/profile-evidence'),
    '../utils/voice': {}, '../utils/reminders': {},
  }, runtime);
  const plan = { primary: [], native: [] };
  const request = (provider, prompt, options, body) => {
    const step = plan[provider].shift() || { error: new Error('Synthetic unavailable') };
    calls.push({ provider, prompt, options, body, at: now });
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        if (step.error) return reject(step.error);
        if (step.raw) return resolve(step.raw);
        const content = JSON.stringify(step.value ?? { approved: true, addressesQuestion: true });
        resolve(provider === 'primary'
          ? { choices: [{ finish_reason: 'stop', message: { content } }] }
          : { response: { candidates: [{ finishReason: 'STOP' }], text: () => content } });
      }, step.delay || 0);
      options.signal?.addEventListener('abort', () => { clearTimer(timer); reject(Object.assign(new Error('Synthetic abort'), { name: 'AbortError' })); }, { once: true });
    });
  };
  ai.openai = primary ? { chat: { completions: { create: (body, options) => request('primary', body.messages[1].content, options, body) } } } : null;
  ai.keys = native ? ['synthetic-google-key'] : [];
  ai.nativeModel = native ? { generateContent: (body, options) => request('native', body.contents[0].parts[0].text, options, body) } : null;
  ai.executeNativeWithRetry = fn => fn();
  ai.performSearch = ai.extractUrl = () => { throw new Error('Recovery must not search or read new pages'); };
  const drive = async work => {
    let done = false, value, failure;
    work.then(result => { done = true; value = result; }, error => { done = true; failure = error; });
    for (let count = 0; count < 100 && !done; count++) {
      await new Promise(setImmediate);
      if (done) break;
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(first, 'every pending request needs a bounded timer');
      now = first[1].at; timers.delete(first[0]); first[1].fn();
    }
    assert.ok(done, 'operation must settle');
    if (failure) throw failure;
    return value;
  };
  return { ai, plan, calls, logs, drive, research, clock: () => now, pending: () => timers.size };
}

function evidence() {
  return {
    question: 'Как работает синтетический проект локально и готова ли интеграция?', sufficient: false,
    sources: [
      { id: 'S1', url: 'https://example.org/project', level: 'page', pageText: 'The project runs locally. Integration is available according to the author.' },
      { id: 'S2', url: 'https://example.org/correction', level: 'page', pageText: 'Independent testing found integration unavailable.' },
    ],
    claims: [
      { sourceId: 'S1', url: 'https://example.org/project', claim: 'Проект работает локально.', status: 'supported', quote: 'The project runs locally.', limitation: 'Требования к оборудованию не установлены.' },
      { sourceId: 'S1', url: 'https://example.org/project', claim: 'Интеграция доступна по заявлению автора.', status: 'reported', quote: 'Integration is available according to the author.' },
      { sourceId: 'S2', url: 'https://example.org/correction', claim: 'Независимая проверка не подтвердила работоспособность интеграции.', status: 'contradicted', quote: 'Independent testing found integration unavailable.' },
    ],
    gaps: ['Совместимость с конкретной версией не проверена.'], errors: [],
    requestedSources: [{ url: 'https://example.org/project', status: 'read' }, { url: 'https://example.org/unread', status: 'unavailable' }],
  };
}

test('research provider configuration defaults to auto, validates required keys and leaves voice independent', () => {
  assert.equal(configuration().researchReviewProvider, 'auto');
  assert.equal(configuration().voiceTranscriptionProvider, 'google');
  for (const mode of ['auto', 'openrouter', 'google']) {
    assert.equal(configuration({ RESEARCH_REVIEW_PROVIDER: mode, GOOGLE_GEMINI_API_KEY: 'synthetic' }).researchReviewProvider, mode);
  }
  assert.throws(() => configuration({ RESEARCH_REVIEW_PROVIDER: 'secret-typo' }), error => error.message.includes('RESEARCH_REVIEW_PROVIDER') && !error.message.includes('secret-typo'));
  assert.throws(() => configuration({ RESEARCH_REVIEW_PROVIDER: 'google' }), /GOOGLE_GEMINI_API_KEY/);
  assert.throws(() => configuration({ RESEARCH_REVIEW_PROVIDER: 'openrouter', AI_API_KEY: undefined }), /AI_API_KEY|OPENROUTER_API_KEY/);
  assert.equal(configuration({ AI_API_KEY: undefined }).researchReviewProvider, 'auto', 'command-only startup remains available');
  for (const url of ['https://openrouter.ai.evil.example/api/v1', 'http://openrouter.ai/api/v1', 'https://secret@openrouter.ai/api/v1', 'https://openrouter.ai/api/v1?secret=key', 'https://openrouter.ai:444/api/v1', 'invalid']) {
    assert.throws(() => configuration({ RESEARCH_REVIEW_PROVIDER: 'openrouter', AI_BASE_URL: url }), error => error.message.includes('AI_BASE_URL') && !error.message.includes(url));
  }
  assert.equal(configuration({ AI_BASE_URL: 'https://custom.example/v1' }).researchReviewProvider, 'auto');
  assert.equal(configuration({ RESEARCH_REVIEW_PROVIDER: 'openrouter', AI_BASE_URL: 'https://openrouter.ai/api/v1/' }).researchReviewProvider, 'openrouter');
});

test('a sole primary reviewer completing at 20 seconds retains the audited answer within its full 40 second budget', async () => {
  const h = harness();
  h.plan.primary.push({ delay: 20000 });
  const result = evidence(); result.requestedSources = [];
  const draft = 'Проект работает локально. [Источник](https://example.org/project)';
  assert.equal(await h.drive(h.ai.finalizeResearchedAnswer(draft, result)), draft);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.timeout, 40000);
  assert.equal(h.clock(), 20000);
});

test('explicit modes never call the other provider; auto still keeps the native reserve', async () => {
  for (const [mode, provider] of [['openrouter', 'primary'], ['google', 'native']]) {
    const h = harness({ mode, native: true });
    h.plan[provider].push({ delay: 20000 });
    assert.equal((await h.drive(h.ai.reviewEvidence('synthetic'))).approved, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].provider, provider);
    assert.equal(h.calls[0].options.timeout, 40000);
  }
  const h = harness({ native: true });
  h.plan.primary.push({ delay: 100000 }); h.plan.native.push({ delay: 20000 });
  assert.equal((await h.drive(h.ai.reviewEvidence('synthetic'))).approved, true);
  assert.deepEqual(h.calls.map(call => call.options.timeout), [18000, 22000]);
  assert.ok(h.calls[0].options.signal.aborted);
  const nativeOnly = harness({ primary: false, native: true });
  nativeOnly.plan.native.push({ delay: 20000 });
  assert.equal((await nativeOnly.drive(nativeOnly.ai.reviewEvidence('synthetic'))).approved, true);
  assert.equal(nativeOnly.calls[0].options.timeout, 40000);
});

test('incomplete, refused or malformed review responses fail safely without raw payloads or provider fallback in explicit mode', async () => {
  const secret = 'SYNTHETIC_SECRET_PAYLOAD';
  for (const raw of [
    { choices: [{ finish_reason: 'length', message: { content: '{"approved":true,"addressesQuestion":true}' } }] },
    { choices: [{ finish_reason: 'stop', message: { refusal: secret, content: '{"approved":true}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: secret } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] },
  ]) {
    const h = harness({ mode: 'openrouter', native: true }); h.plan.primary.push({ raw });
    await assert.rejects(h.drive(h.ai.reviewEvidence('private synthetic question')), error => error.code === 'EVIDENCE_REVIEW_INVALID');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.maxRetries, 0);
    assert.ok(!h.logs.join('\n').includes(secret));
    assert.ok(!h.logs.join('\n').includes('private synthetic question'));
  }
});

test('technical timeout and content rejection produce distinct honest refusals', async () => {
  const result = { ...evidence(), sources: [], claims: [{ claim: 'No quote-backed candidate', url: 'https://example.org/project' }] };
  const h = harness(); h.plan.primary.push({ delay: 100000 });
  const technical = await h.drive(h.ai.finalizeResearchedAnswer('UNCHECKED_DRAFT', result));
  assert.match(technical, /не удалось дождаться/i);
  assert.doesNotMatch(technical, /не прошёл проверку точности|неточн|UNCHECKED_DRAFT/i);
  const rejected = harness(); rejected.plan.primary.push({ value: { approved: false, addressesQuestion: true, answer: '' } });
  const content = await rejected.drive(rejected.ai.finalizeResearchedAnswer('UNCHECKED_DRAFT', result));
  assert.match(content, /не подтвержд|не подтвердил/i);
  assert.notEqual(technical, content);
});

test('one separately audited short candidate recovers after a full timeout without losing evidence, caveats or source coverage', async () => {
  const h = harness(); h.plan.primary.push({ delay: 100000 }, { delay: 2000 });
  const result = evidence();
  const answer = await h.drive(h.ai.finalizeResearchedAnswer('UNCHECKED_DRAFT_AND_INVENTION', result));
  assert.equal(h.calls.length, 2);
  assert.match(answer, /Проект работает локально/);
  assert.match(answer, /сообщает|заявлен/);
  assert.match(answer, /Независимая проверка/);
  assert.match(answer, /Требования к оборудованию не установлены/);
  assert.match(answer, /Совместимость с конкретной версией не проверена/);
  assert.match(answer, /example.org\/unread/);
  assert.doesNotMatch(answer, /UNCHECKED_DRAFT_AND_INVENTION/);
  assert.ok(answer.length <= 1800);
  assert.equal(h.calls[1].options.timeout, 25000);
  for (const source of result.sources) assert.ok(h.calls[1].prompt.includes(source.pageText));
  assert.ok(h.calls[1].prompt.includes(result.question));
  assert.ok(h.calls[1].prompt.includes(result.gaps[0]));
  assert.ok(h.calls[1].prompt.includes('contradicted'));
  assert.doesNotMatch(h.calls[1].prompt, /UNCHECKED_DRAFT_AND_INVENTION/);
  assert.equal(h.clock(), 42000);
});

test('short recovery never publishes a rejected, wrong-subject or invalid candidate, and stops after one attempt', async () => {
  for (const verdict of [null, {}, { approved: true }, { approved: true, addressesQuestion: false },
    { approved: false, addressesQuestion: true, answer: 'UNREVIEWED_CORRECTION' }]) {
    const h = harness();
    h.plan.primary.push({ value: { approved: false, addressesQuestion: true, answer: '' } },
      verdict === null ? { raw: { choices: [] } } : { value: verdict });
    const answer = await h.drive(h.ai.finalizeResearchedAnswer('UNCHECKED_DRAFT', evidence()));
    assert.equal(h.calls.length, 2);
    assert.doesNotMatch(answer, /UNCHECKED_DRAFT|UNREVIEWED_CORRECTION|Проект работает локально/);
    assert.match(answer, /example.org\/unread/);
  }
});

test('both audit stages share a 65 second ceiling and abort timed-out requests', async () => {
  const h = harness(); h.plan.primary.push({ delay: 100000 }, { delay: 100000 });
  const answer = await h.drive(h.ai.finalizeResearchedAnswer('UNCHECKED_DRAFT', evidence()));
  assert.equal(h.clock(), 65000);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.options.signal.aborted));
  assert.equal(h.pending(), 0);
  assert.doesNotMatch(answer, /UNCHECKED_DRAFT|Проект работает локально/);
  assert.match(answer, /не удалось дождаться/i);
});

test('short candidates omit oversized claims whole and do not fabricate support for missing quotations', () => {
  const { research } = harness();
  const result = evidence();
  result.claims.unshift({ ...result.claims[0], claim: 'OVERSIZED_CLAIM'.repeat(150), limitation: 'Never remove this limitation.' });
  result.claims.push({ ...result.claims[0], claim: 'FABRICATED_FACT', quote: 'This quote is not in any page.' });
  const candidate = research.shortResearchAnswer(result);
  assert.ok(candidate && candidate.length <= 1800);
  assert.doesNotMatch(candidate, /OVERSIZED_CLAIM|FABRICATED_FACT/);
  assert.match(candidate, /Проект работает локально/);
  assert.match(candidate, /Независимая проверка/);
});

test('full audits require explicit subject confirmation even without supplied links', async () => {
  for (const verdict of [{ approved: true }, { approved: true, addressesQuestion: false }]) {
    const h = harness(); h.plan.primary.push({ value: verdict });
    const result = { claims: [{ claim: 'No source-backed recovery', url: 'https://example.org/project' }], sources: [], gaps: [] };
    const answer = await h.drive(h.ai.finalizeResearchedAnswer('UNCHECKED_DRAFT', result));
    assert.doesNotMatch(answer, /UNCHECKED_DRAFT/);
    assert.equal(h.calls.length, 1);
  }
});

test('a valid full correction is retained, while short approval can only release its prebuilt candidate', async () => {
  const full = harness();
  full.plan.primary.push({ value: { approved: false, addressesQuestion: true, answer: 'COMPLETE_CORRECTED_ANSWER' } });
  const result = evidence();
  assert.match(await full.drive(full.ai.finalizeResearchedAnswer('WRONG_DRAFT', result)), /^COMPLETE_CORRECTED_ANSWER/);
  assert.equal(full.calls.length, 1);
  const short = harness();
  short.plan.primary.push({ value: { approved: false, addressesQuestion: true, answer: '' } },
    { value: { approved: true, addressesQuestion: true, answer: 'UNREVIEWED_MODEL_ADDITION' } });
  const expected = short.research.shortResearchAnswer(result);
  const answer = await short.drive(short.ai.finalizeResearchedAnswer('WRONG_DRAFT', result));
  assert.equal(answer, expected);
  assert.doesNotMatch(answer, /UNREVIEWED_MODEL_ADDITION|WRONG_DRAFT/);
  assert.equal(short.calls.length, 2);
});

test('approved and corrected audits accept structured unused diagnostics without exposing them', async () => {
  for (const approved of [true, false]) {
    const h = harness();
    const diagnostics = { reason: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' };
    h.plan.primary.push({ value: { approved, addressesQuestion: true,
      answer: approved ? '' : 'CORRECTED_ANSWER', issues: [diagnostics] } });
    const result = evidence(); result.requestedSources = [];
    const answer = await h.drive(h.ai.finalizeResearchedAnswer('APPROVED_DRAFT', result));
    assert.equal(answer, approved ? 'APPROVED_DRAFT' : 'CORRECTED_ANSWER');
    assert.equal(h.calls.length, 1, 'Unused diagnostic structure must not trigger recovery');
    assert.doesNotMatch(answer, /SYNTHETIC_PRIVATE_DIAGNOSTIC/);
    assert.ok(!h.logs.join('\n').includes(diagnostics.reason));
  }
});

test('unavailable and invalid native audits keep their real failure category', async () => {
  const result = { claims: [{ claim: 'No source-backed recovery' }], sources: [], gaps: [] };
  for (const [step, expected] of [
    [{ error: Object.assign(new Error('SECRET_NATIVE_PAYLOAD'), { code: 'SECRET_CODE' }) }, /временно недоступен/],
    [{ raw: { response: { candidates: [{ finishReason: 'MAX_TOKENS' }], text: () => '{"approved":true,"addressesQuestion":true}' } } }, /некорректный или неполный/],
    [{ raw: { response: { candidates: [{ finishReason: 'STOP' }], text: () => '{"approved":"true"}' } } }, /некорректный или неполный/],
    [{ raw: { response: { candidates: [{ finishReason: 'STOP' }], promptFeedback: { blockReason: 'SAFETY' }, text: () => '{"approved":true,"addressesQuestion":true}' } } }, /некорректный или неполный/],
  ]) {
    const h = harness({ mode: 'google', native: true }); h.plan.native.push(step);
    const answer = await h.drive(h.ai.finalizeResearchedAnswer('UNCHECKED_DRAFT', result));
    assert.match(answer, expected);
    assert.doesNotMatch(answer, /UNCHECKED_DRAFT|SECRET_NATIVE_PAYLOAD|не прошёл проверку точности/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].provider, 'native');
    assert.ok(!h.logs.join('\n').includes('SECRET'));
  }
  const none = harness({ primary: false });
  await assert.rejects(none.drive(none.ai.reviewEvidence('Synthetic')), error => error.code === 'EVIDENCE_REVIEW_UNAVAILABLE');
  assert.equal(none.calls.length, 0);
});

test('long caveats or source coverage cannot be cut to squeeze a short answer into the limit', () => {
  const { research } = harness();
  for (const kind of ['gaps', 'coverage']) {
    const result = evidence();
    if (kind === 'gaps') result.gaps.push('Существенное ограничение. '.repeat(100));
    else result.requestedSources = Array.from({ length: 8 }, (_, index) => ({ url: `https://example.org/${index}/${'a'.repeat(230)}`, status: 'unavailable' }));
    assert.equal(research.shortResearchAnswer(result), '', kind);
  }
  const result = evidence();
  result.claims[0].limitation = 'Полное существенное условие. '.repeat(30);
  const answer = research.shortResearchAnswer(result);
  assert.ok(answer.length <= 1800);
  if (answer.includes(result.claims[0].claim)) assert.ok(answer.includes(result.claims[0].limitation.trim()));
  else assert.doesNotMatch(answer, /Полное существенное условие/);
  assert.ok(answer.includes(result.gaps[0]));
});

test('native quota retry cannot start another request once the shared review deadline expires', async () => {
  const h = harness({ mode: 'google', native: true });
  h.ai.executeNativeWithRetry = Object.getPrototypeOf(h.ai).executeNativeWithRetry.bind(h.ai);
  h.ai.rotateNativeKey = () => {};
  h.plan.native.push({ delay: 40000, error: new Error('429 quota') });
  await assert.rejects(h.drive(h.ai.reviewEvidence('Synthetic')), error => error.code === 'ETIMEDOUT');
  assert.equal(h.calls.length, 1);
  assert.equal(h.clock(), 40000);
  assert.equal(h.calls[0].options.signal.aborted, true);
});

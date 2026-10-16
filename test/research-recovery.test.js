const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const researchModule = require('../src/services/research');

const supplied = ['https://example.org/memory-framework', 'https://example.org/memory-model'];
const unrelated = 'https://example.org/unrelated-translator';
const frameworkPage = 'The framework exposes a local memory service. OpenClaw integration has not been tested.';
const modelPage = 'The model uses 30B total parameters and 3B active parameters. Hardware requirements remain unverified.';
const unrelatedPage = 'This is a translation model and does not describe the memory framework.';
const initialClaim = { claim: 'A local memory service is available.', status: 'supported', sourceId: 'S1',
  quote: 'The framework exposes a local memory service.', limitation: 'OpenClaw integration is unverified.' };
const recoveredClaim = { claim: 'The memory model has 30B total parameters and 3B active parameters.',
  status: 'supported', sourceId: 'S2', quote: 'The model uses 30B total parameters and 3B active parameters.',
  limitation: 'Hardware requirements remain unverified.' };
const unrelatedClaim = { claim: 'The translation model exists.', status: 'supported', sourceId: 'S3', quote: unrelatedPage };
const empty = { claims: [], sufficient: false, addressesQuestion: true, gaps: ['OpenClaw integration is still unverified.'], followUpQuery: '' };
const partial = { ...empty, claims: [initialClaim], followUpQuery: 'memory framework local OpenClaw requirements' };
const recovered = { ...empty, claims: [recoveredClaim] };
const input = { sender: 'Synthetic owner', text: 'Сыч, глянь все ссылки, объясни локальный запуск и интеграцию OpenClaw подробно',
  replyText: `Memory framework: ${supplied[0]}\nModel: ${supplied[1]}\nDuplicate: ${supplied[0]}` };
const isRecovery = prompt => prompt.includes('ВОССТАНОВЛЕНИЕ ЧАСТИЧНОГО ОТВЕТА');
const isAudit = prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА');
const clone = value => structuredClone(value);

function harness({ latest = empty, recovery = recovered, first = partial, audit = { approved: true, addressesQuestion: true } } = {}) {
  const config = { geminiKeys: [], searchProvider: 'tavily', mainModel: 'synthetic-writer', logicModel: 'synthetic-planner', maxOutputTokens: 1000 };
  const promptModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/prompts.js'), 'utf8'), {
    module: promptModule, require: () => config,
  });
  const state = { reads: [], searches: [], evidence: [], recovery: [], audits: [], writers: [], logs: [], result: null };
  const deps = {
    '@google/generative-ai': {}, openai: {}, '@tavily/core': {},
    axios: new Proxy({}, { get() { throw Error('Real network access is forbidden'); } }),
    '../config': config, '../core/prompts': promptModule.exports,
    './storage': { initGoogleStats() {}, resetStatsIfNeeded: () => false, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': { sendRich: async () => { throw Error('Telegram sends are forbidden'); } },
    './youtube': { isYouTubeUrl: () => false }, './youtube-gemini': {},
    '../utils/content-policy': require('../src/utils/content-policy'),
    '../utils/async': require('../src/utils/async'),
    '../utils/private-context': require('../src/utils/private-context'),
    '../utils/profile-evidence': require('../src/utils/profile-evidence'),
    '../utils/voice': {}, '../utils/reminders': {},
    './research': { ...researchModule, research: async options => { state.result = await researchModule.research(options); return state.result; } },
  };
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8'), {
    module: box, require: name => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; },
    console: { log: (...args) => state.logs.push(args.join(' ')), warn() {}, error: (...args) => state.logs.push(args.join(' ')) },
    Buffer, setTimeout, clearTimeout, AbortController,
  });
  const ai = box.exports;
  ai.runLogicModel = async () => ({ needsSearch: true, searchQuery: 'memory framework local OpenClaw' });
  ai.extractUrl = async url => {
    state.reads.push(url);
    return url === supplied[0] ? frameworkPage : url === supplied[1] ? modelPage
      : url === unrelated ? unrelatedPage : 'Other synthetic primary page.';
  };
  ai.performSearch = async query => {
    state.searches.push(query);
    return [unrelated, ...Array.from({ length: 4 }, (_, i) => `https://example.org/other-${i}`)]
      .map(url => ({ url, content: 'Synthetic search snippet.', title: 'Synthetic page' }));
  };
  ai.reviewEvidence = async (prompt, options) => {
    if (isAudit(prompt)) {
      state.audits.push(prompt);
      if (typeof audit === 'function') return audit(prompt, options);
      return clone(audit);
    }
    if (isRecovery(prompt)) {
      state.recovery.push({ prompt, timeoutMs: options?.timeoutMs });
      if (typeof recovery === 'function') return recovery(prompt, options);
      return clone(recovery);
    }
    state.evidence.push({ prompt, timeoutMs: options?.timeoutMs });
    const response = state.evidence.length === 1 ? first : latest;
    if (typeof response === 'function') return response(prompt, options);
    return clone(response);
  };
  ai.openai = { chat: { completions: { create: async request => {
    state.writers.push(request);
    return { choices: [{ message: { content: `RECOVERY_FINAL_RESPONSE: ${recoveredClaim.claim} [Model](${supplied[1]})` } }] };
  } } } };
  return { ai, state };
}

for (const [name, latest] of [
  ['an empty later review', empty],
  ['a later wrong-subject review', { ...empty, claims: [initialClaim], addressesQuestion: false }],
  ['later claims with missing exact quotations', { ...empty, claims: [{ ...initialClaim, quote: 'A fabricated quote absent from every source.' }] }],
  ['later conclusions supported only by an unrelated search result', { ...empty, claims: [unrelatedClaim] }],
]) {
  test(`recovery after ${name} reaches the real writer and final audit`, async () => {
    const { ai, state } = harness({ latest });
    const answer = await ai.getResponse([], input);
    assert.deepEqual(state.reads.slice(0, 2), supplied, 'Both supplied URLs must be read before general search');
    assert.equal(state.evidence.length, 2);
    assert.equal(state.searches.length, 1, 'Recovery is a fresh review, never an extra uncontrolled search');
    assert.equal(state.recovery.length, 1, 'Exactly one targeted review can recover a partial answer');
    assert.equal(state.writers.length, 1);
    assert.equal(state.audits.length, 1);
    assert.match(answer, /RECOVERY_FINAL_RESPONSE/);
    assert.doesNotMatch(answer, /unrelated-translator/);
    assert.equal(state.result.claims.length, 1, 'Recovery replaces the assessment rather than merging stale claims');
    assert.equal(state.result.claims[0].claim, recoveredClaim.claim);
    assert.equal(state.result.claims[0].url, supplied[1]);
    const writerPrompt = state.writers[0].messages[1].content[0].text;
    assert.match(writerPrompt, /Hardware requirements remain unverified/);
    assert.doesNotMatch(writerPrompt, /A local memory service is available/);
    const recoveryPrompt = state.recovery[0].prompt;
    for (const page of [frameworkPage, modelPage, unrelatedPage]) assert.ok(recoveryPrompt.includes(page));
    assert.ok(recoveryPrompt.includes(initialClaim.claim), 'Earlier candidates remain available for a fresh check');
    assert.ok(recoveryPrompt.includes(input.text), 'Recovery must retain the real original question');
    assert.ok(state.recovery[0].timeoutMs > 0 && state.recovery[0].timeoutMs <= 20000);
  });
}

for (const [name, recovery] of [
  ['empty', empty], ['null', null], ['invalid JSON shape', { approved: true }],
  ['wrong subject', { ...recovered, addressesQuestion: false }],
  ['fabricated quote', { ...recovered, claims: [{ ...recoveredClaim, quote: 'Not in the supplied evidence.' }] }],
  ['only an unrelated search claim', { ...empty, claims: [unrelatedClaim] }],
]) {
  test(`${name} recovery cannot resurrect earlier unchecked candidates`, async () => {
    const { ai, state } = harness({ recovery });
    const answer = await ai.getResponse([], input);
    assert.equal(state.recovery.length, 1);
    assert.equal(state.result.claims.length, 0);
    assert.equal(state.writers.length, 0);
    assert.equal(state.audits.length, 0);
    assert.doesNotMatch(answer, /RECOVERY_FINAL_RESPONSE|A local memory service is available|unrelated-translator/);
    for (const url of supplied) assert.ok(answer.includes(url));
  });
}

test('an accepted later contradiction is preserved without recovery', async () => {
  const correction = { ...initialClaim, claim: 'OpenClaw integration has not been tested.', status: 'contradicted',
    quote: 'OpenClaw integration has not been tested.' };
  const { ai, state } = harness({ latest: { ...empty, claims: [correction] } });
  await ai.getResponse([], input);
  assert.equal(state.recovery.length, 0, 'A supported correction must not be replaced by an earlier claim');
  assert.equal(state.result.claims[0].status, 'contradicted');
  assert.equal(state.result.claims[0].claim, correction.claim);
  assert.match(state.writers[0].messages[1].content[0].text, /OpenClaw integration has not been tested/);
});

test('a technical evidence failure after its retry is never rescued as an ordinary empty review', async () => {
  const unavailable = () => { throw Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), { code: 'EVIDENCE_REVIEW_UNAVAILABLE' }); };
  const { ai, state } = harness({ first: unavailable, latest: unavailable });
  const answer = await ai.getResponse([], { ...input, text: 'Сыч, прочитай исходные ссылки' });
  assert.equal(state.result.verificationFailed, true);
  assert.equal(state.recovery.length, 0);
  assert.equal(state.writers.length, 0);
  assert.doesNotMatch(answer, /PRIVATE_PROVIDER_ERROR|unrelated-translator/);
});

test('a recovery exception has no retry or stale claim fallback', async () => {
  const { ai, state } = harness({ recovery: () => { throw Error('PRIVATE_RECOVERY_EXCEPTION'); } });
  const answer = await ai.getResponse([], input);
  assert.equal(state.recovery.length, 1);
  assert.equal(state.result.claims.length, 0);
  assert.equal(state.writers.length, 0);
  assert.doesNotMatch(answer, /PRIVATE_RECOVERY_EXCEPTION|A local memory service is available|unrelated-translator/);
});

test('recovery preserves unread-source coverage, partial pages and unknown integration gaps', async () => {
  const { ai, state } = harness();
  ai.extractUrl = async url => {
    state.reads.push(url);
    if (url === supplied[1]) return null;
    return url === supplied[0] ? `${frameworkPage}\n${'navigation '.repeat(8000)}` : unrelatedPage;
  };
  const answer = await ai.getResponse([], input);
  assert.equal(state.recovery.length, 1);
  assert.equal(state.result.requestedSources[1].status, 'unavailable');
  assert.equal(state.result.sufficient, false);
  assert.equal(state.result.claims.length, 0, 'A recovery quote for an unread model page cannot be accepted');
  assert.ok(state.result.sources.some(source => source.supplied && source.truncated));
  assert.ok(state.result.gaps.some(gap => /прочитать|OpenClaw/.test(gap)));
  assert.ok(answer.includes(supplied[1]));
  assert.doesNotMatch(answer, /unrelated-translator|404|не существует/);
});

test('a freshly revalidated partial answer still discloses the unread original model page', async () => {
  const { ai, state } = harness({ recovery: { ...empty, claims: [initialClaim], sufficient: true } });
  ai.extractUrl = async url => {
    state.reads.push(url);
    return url === supplied[0] ? frameworkPage : url === supplied[1] ? null : unrelatedPage;
  };
  const answer = await ai.getResponse([], input);
  assert.equal(state.recovery.length, 1);
  assert.equal(state.result.claims.length, 1);
  assert.equal(state.result.claims[0].url, supplied[0]);
  assert.equal(state.result.sufficient, false, 'Unread originals must prevent full-coverage claims');
  assert.equal(state.writers.length, 1);
  assert.equal(state.audits.length, 1);
  assert.ok(answer.includes(supplied[1]));
  assert.match(answer, /Не удалось прочитать/);
  assert.doesNotMatch(answer, /unrelated-translator/);
});

test('failed final auditing after recovery never releases the recovered writer draft', async () => {
  const { ai, state } = harness({ audit: null });
  const answer = await ai.getResponse([], input);
  assert.equal(state.recovery.length, 1);
  assert.equal(state.writers.length, 1);
  assert.equal(state.audits.length, 1);
  assert.doesNotMatch(answer, /RECOVERY_FINAL_RESPONSE|unrelated-translator/);
  assert.ok(answer.includes(supplied[0]));
});

test('review diagnostics contain counts and reason codes without source text, identities or quotes', async () => {
  const { ai, state } = harness({ latest: { ...empty, claims: [{ ...initialClaim, quote: 'A fabricated quote absent from every source.' }] } });
  await ai.getResponse([], input);
  assert.equal(state.result.reviewStats.length, 3);
  const json = JSON.stringify(state.result.reviewStats);
  for (const secret of [frameworkPage, modelPage, unrelatedPage, initialClaim.claim, initialClaim.quote, supplied[0], 'S1']) {
    assert.ok(!json.includes(secret), `Telemetry leaked source payload: ${secret}`);
  }
  for (const stat of state.result.reviewStats) {
    assert.ok(['evidence', 'recovery'].includes(stat.phase));
    assert.equal(typeof stat.proposedClaims, 'number');
    assert.equal(typeof stat.acceptedClaims, 'number');
    assert.equal(typeof stat.addressesQuestion, 'boolean');
    assert.ok(stat.reasons && typeof stat.reasons === 'object');
    for (const [code, count] of Object.entries(stat.reasons)) {
      assert.match(code, /^[A-Z][A-Z0-9_]*$/);
      assert.ok(Number.isInteger(count) && count >= 0);
    }
  }
  assert.ok(Object.values(state.result.reviewStats[1].reasons).some(count => count > 0));
  assert.equal(state.result.reviewStats[2].phase, 'recovery');
  assert.equal(state.result.reviewStats[2].acceptedClaims, 1);
});

test('conservative supplied-link answers deduplicate originals and never offer unrelated search URLs', () => {
  const answer = researchModule.conservativeAnswer({ claims: [], gaps: [], errors: [], verificationFailed: false,
    requestedSources: [{ url: supplied[0], status: 'read' }, { url: supplied[0], status: 'read' },
      { url: supplied[1], status: 'unavailable' }],
    sources: [{ url: supplied[0], supplied: true }, { url: supplied[1], supplied: true }, { url: unrelated }] });
  assert.equal(answer.split(supplied[0]).length - 1, 1);
  assert.ok(answer.includes(supplied[1]));
  assert.doesNotMatch(answer, /unrelated-translator|Что произошло и почему/);
  assert.match(answer, /прочита|провер|вывод/i);
});

test('conservative answers without supplied links expose only claim-backed source URLs', () => {
  const answer = researchModule.conservativeAnswer({ claims: [{ ...initialClaim, url: supplied[0] }],
    gaps: [], errors: [], verificationFailed: true,
    sources: [{ url: unrelated }, { url: supplied[0] }, { url: supplied[1] }] });
  assert.ok(answer.includes(supplied[0]));
  assert.doesNotMatch(answer, /unrelated-translator|memory-model/);
  const noClaims = researchModule.conservativeAnswer({ claims: [], sources: [{ url: unrelated }], verificationFailed: false });
  assert.doesNotMatch(noClaims, /unrelated-translator/);
});

async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

test('an empty additional search does not re-review and erase an already validated partial answer', async () => {
  const { ai, state } = harness();
  ai.performSearch = async () => [];
  await ai.getResponse([], input);
  assert.equal(state.evidence.length, 1, 'The exact same source pack does not need another broad review');
  assert.equal(state.recovery.length, 0);
  assert.equal(state.result.claims[0]?.claim, initialClaim.claim);
  assert.equal(state.writers.length, 1);
  assert.equal(state.audits.length, 1);
});

test('a partial review with rejected quotes gets one fresh chance to select exact source quotations', async () => {
  const { ai, state } = harness({ first: { ...partial, claims: [initialClaim,
    { ...recoveredClaim, quote: 'A cleaned-up quote that does not literally occur in the Markdown source.' }] } });
  ai.performSearch = async () => [];
  await ai.getResponse([], input);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.recovery.length, 1);
  assert.equal(state.result.claims.length, 1);
  assert.equal(state.result.claims[0].claim, recoveredClaim.claim);
  assert.equal(state.writers.length, 1);
  assert.equal(state.audits.length, 1);
});

test('the shared deadline reserves time for one recovery and never exceeds the caller budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const stages = [];
  const started = Date.now();
  const work = researchModule.research({ question: 'Local memory setup with OpenClaw', budgetMs: 90000,
    suppliedUrls: supplied, plan: { searchQuery: 'memory framework local setup' },
    read: async url => url === supplied[0] ? frameworkPage : modelPage,
    search: async () => [{ url: unrelated, content: unrelatedPage }],
    review: async (prompt, options) => {
      const phase = isRecovery(prompt) ? 'recovery' : 'evidence';
      stages.push({ phase, at: Date.now() - started, timeoutMs: options.timeoutMs });
      if (phase === 'recovery') return recovered;
      // Valid but empty reviews consume their allotted budget without a technical failure.
      const delay = stages.length === 1 ? Math.min(39000, options.timeoutMs - 1) : options.timeoutMs - 1;
      return new Promise(resolve => setTimeout(() => resolve({ ...empty, followUpQuery: stages.length === 1 ? 'targeted local setup' : '' }), delay));
    },
  });
  await flush();
  t.mock.timers.tick(Math.min(39000, stages[0].timeoutMs - 1));
  await flush();
  assert.equal(stages[1]?.phase, 'evidence');
  t.mock.timers.tick(stages[1].timeoutMs - 1);
  await flush();
  const result = await work;
  const recoveryStage = stages.find(stage => stage.phase === 'recovery');
  assert.ok(recoveryStage, 'Normal evidence review must leave recovery reserve');
  assert.ok(recoveryStage.at <= 70000, `Recovery started too late: ${recoveryStage.at}ms`);
  assert.ok(recoveryStage.timeoutMs > 0 && recoveryStage.timeoutMs <= 20000);
  assert.ok(recoveryStage.at + recoveryStage.timeoutMs <= 90000);
  assert.equal(stages.filter(stage => stage.phase === 'recovery').length, 1);
  assert.equal(result.claims[0]?.claim, recoveredClaim.claim);
});

test('a hanging recovery settles at its deadline without reviving earlier candidates', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const stages = [];
  const work = researchModule.research({ question: 'Read both memory sources', budgetMs: 90000,
    suppliedUrls: supplied, plan: { searchQuery: 'memory framework local setup' },
    read: async url => url === supplied[0] ? frameworkPage : modelPage,
    search: async () => [{ url: unrelated, content: unrelatedPage }],
    review: async (prompt, options) => {
      stages.push({ phase: isRecovery(prompt) ? 'recovery' : 'evidence', timeoutMs: options.timeoutMs });
      if (isRecovery(prompt)) return new Promise(() => {});
      return stages.length === 1 ? partial : empty;
    },
  });
  await flush();
  const attempt = stages.find(stage => stage.phase === 'recovery');
  assert.ok(attempt, 'Recovery must be attempted before testing its timeout');
  assert.ok(attempt.timeoutMs > 0 && attempt.timeoutMs <= 20000);
  t.mock.timers.tick(attempt.timeoutMs);
  await flush();
  const result = await work;
  assert.equal(result.claims.length, 0);
  assert.equal(stages.filter(stage => stage.phase === 'recovery').length, 1);
  assert.equal(result.verificationFailed, true);
  assert.ok(result.errors.some(error => error.code === 'ETIMEDOUT' || error.code === 'RESEARCH_DEADLINE'));
});

for (const [name, first] of [['empty', empty], ['partial', partial]]) {
  test(`a planning-boundary search timeout leaves recovery available after an initial ${name} assessment`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const phases = [];
    let searchStarted = false;
    const work = researchModule.research({ question: 'Memory local setup and OpenClaw', budgetMs: 90000,
      suppliedUrls: supplied, plan: { searchQuery: 'memory local setup' },
      read: async url => url === supplied[0] ? frameworkPage : modelPage,
      search: async () => { searchStarted = true; return new Promise(() => {}); },
      review: async (prompt, options) => {
        const phase = isRecovery(prompt) ? 'recovery' : 'evidence';
        phases.push({ phase, prompt, timeoutMs: options.timeoutMs });
        if (phase === 'recovery') return recovered;
        return new Promise(resolve => setTimeout(() => resolve(first), 39000));
      },
    });
    await flush();
    t.mock.timers.tick(39000);
    await flush();
    assert.equal(searchStarted, true);
    t.mock.timers.tick(31000);
    await flush();
    const result = await work;
    const recoveryStage = phases.find(stage => stage.phase === 'recovery');
    assert.ok(recoveryStage, 'A normal-phase planning cutoff must not consume the reserved fresh-review opportunity');
    assert.ok(recoveryStage.timeoutMs > 0 && recoveryStage.timeoutMs <= 20000);
    assert.ok(recoveryStage.prompt.includes(frameworkPage));
    assert.ok(recoveryStage.prompt.includes(modelPage));
    assert.equal(result.claims[0]?.claim, recoveredClaim.claim);
    assert.equal(result.verificationFailed, false);
    assert.equal(result.errors.length, 0, 'Hitting the reserved planning boundary is not a provider failure');
  });
}

for (const outcome of ['corrected', 'invalid', 'deadline']) {
  test(`new contradictory evidence at the planning deadline needs a fresh review before publication (${outcome})`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const advisoryUrl = 'https://example.org/current-advisory';
    const advisory = 'The earlier local service instructions are withdrawn in the current release. Use a remote service.';
    const phases = [];
    const { ai, state } = harness();
    ai.performSearch = async query => {
      state.searches.push(query);
      // Search completes within its 31s remainder; the final source read then
      // finishes exactly at the reserved normal-phase boundary.
      t.mock.timers.setTime(1000 + 68000);
      return [{ url: advisoryUrl, content: advisory }];
    };
    ai.extractUrl = async url => {
      state.reads.push(url);
      if (url === advisoryUrl) {
        t.mock.timers.setTime(1000 + 70000);
        return advisory;
      }
      return url === supplied[0] ? frameworkPage : modelPage;
    };
    ai.reviewEvidence = async (prompt, options) => {
      if (isAudit(prompt)) { state.audits.push(prompt); return { approved: true, addressesQuestion: true }; }
      const phase = isRecovery(prompt) ? 'recovery' : 'evidence';
      phases.push({ phase, prompt, timeoutMs: options.timeoutMs });
      if (phase === 'evidence') {
        t.mock.timers.setTime(1000 + 39000);
        return partial;
      }
      if (outcome === 'invalid') return null;
      if (outcome === 'deadline') return new Promise(() => {});
      return { ...empty, claims: [
        { ...initialClaim, status: 'contradicted', claim: 'OpenClaw integration has not been tested.',
          quote: 'OpenClaw integration has not been tested.' },
        { claim: 'The current advisory withdraws the earlier local instructions.', status: 'contradicted',
          sourceId: 'S3', quote: advisory },
      ] };
    };
    const work = ai.getResponse([], input);
    await flush();
    const recoveryStage = phases.find(stage => stage.phase === 'recovery');
    if (outcome === 'deadline' && recoveryStage) {
      t.mock.timers.tick(recoveryStage.timeoutMs);
      await flush();
    }
    await work;
    assert.ok(recoveryStage, 'Newly read sources make the older assessment stale even when it contains valid earlier claims');
    assert.ok(recoveryStage.prompt.includes(advisory), 'Fresh review must include the newly read contradiction');
    assert.ok(recoveryStage.prompt.includes(frameworkPage));
    assert.equal(phases.filter(phase => phase.phase === 'recovery').length, 1);
    assert.ok(recoveryStage.timeoutMs > 0 && recoveryStage.timeoutMs <= 20000);
    assert.ok(!state.result.claims.some(claim => claim.claim === initialClaim.claim), 'Earlier positive claims must not bypass the new evidence');
    if (outcome === 'corrected') {
      assert.equal(state.writers.length, 1);
      assert.equal(state.audits.length, 1);
      assert.equal(state.result.claims.length, 2);
      const writerPrompt = state.writers[0].messages[1].content[0].text;
      assert.ok(writerPrompt.includes(advisory));
      assert.ok(!writerPrompt.includes(initialClaim.claim));
    } else {
      assert.equal(state.writers.length, 0, 'A failed fresh review cannot publish the old positive answer');
      assert.equal(state.audits.length, 0);
      assert.equal(state.result.claims.length, 0);
    }
  });
}

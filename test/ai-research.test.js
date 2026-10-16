const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness(extraDependencies = {}, runtime = {}) {
  const calls = [];
  const notifications = [];
  const config = { geminiKeys: [], searchProvider: 'tavily', mainModel: 'writer', logicModel: 'planner', maxOutputTokens: 1000 };
  const promptsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/prompts.js'), 'utf8'), { module: promptsModule, require: () => config });
  const dependencies = {
    '../utils/private-context': require('../src/utils/private-context'),
    '../utils/profile-evidence': require('../src/utils/profile-evidence'),
    '@google/generative-ai': {}, '../config': config, '../core/prompts': promptsModule.exports,
    axios: {}, openai: {}, '@tavily/core': {},
    './storage': { initGoogleStats() {}, resetStatsIfNeeded: () => false, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': { sendRich: async (...args) => { notifications.push(args); } }, './youtube': { isYouTubeUrl: () => false }, './youtube-gemini': {},
    '../utils/content-policy': require('../src/utils/content-policy'), './research': require('../src/services/research'),
    '../utils/async': require('../src/utils/async'), '../utils/voice': {}, '../utils/reminders': {},
  };
  const box = { exports: {} };
  Object.assign(dependencies, extraDependencies);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8'), {
    module: box, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    console: { log() {}, error() {}, warn() {} }, Buffer, setTimeout, clearTimeout, AbortController, ...runtime,
  });
  const ai = box.exports;
  ai.openai = { chat: { completions: { create: async request => { calls.push(request); return { choices: [{ message: { content: 'Ответ Сыча [Источник](https://example.org/countries)' } }] }; } } } };
  ai.runLogicModel = async () => ({ needsSearch: true, searchQuery: 'official countries' });
  ai.performSearch = async () => [{ url: 'https://example.org/countries', title: 'Countries', content: 'Kazakhstan is supported for Claude.ai.' }];
  ai.extractUrl = async () => 'Kazakhstan is supported for Claude.ai.';
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА') ? { approved: true } : ({ claims: [{ claim: 'Kazakhstan supported.', status: 'supported', sourceId: 'S1', quote: 'Kazakhstan is supported for Claude.ai.', limitation: 'No guarantee for a card.' }], sufficient: true });
  return { ai, calls, config, notifications };
}

test('all links from the replied post are read even if the planner disables search', async () => {
  const { ai, calls } = harness();
  const urls = ['https://example.org/framework', 'https://example.org/model'];
  const reads = [];
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.extractUrl = async url => { reads.push(url); return 'The memory project and model are available.'; };
  ai.performSearch = async () => { throw Error('Direct sources should be sufficient'); };
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА')
    ? { approved: true, addressesQuestion: true }
    : { claims: [{ claim: 'The memory project is available.', status: 'supported', sourceId: 'S1',
      quote: 'The memory project and model are available.' }], sufficient: true, addressesQuestion: true };
  for (const text of ['Сыч глянь все ссылки и дай подробный отчёт', 'Сыч, изучи два документа и сопоставь данные']) {
    reads.length = 0;
    await ai.getResponse([], { sender: 'Тест', text, replyText: `${urls[0]}\n${urls[1]}\n${urls[0]}` });
    assert.deepEqual(reads, urls);
  }
  assert.match(calls[0].messages[1].content[0].text, /memory project is available/);
});

test('a recheck prioritizes the original source context over a wrong previous bot answer', async () => {
  const { ai } = harness();
  let planner;
  const reads = [];
  ai.runLogicModel = async prompt => { planner = prompt; return { needsSearch: false }; };
  ai.extractUrl = async url => { reads.push(url); return 'Original memory framework exists.'; };
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА')
    ? { approved: true, addressesQuestion: true }
    : { claims: [{ claim: 'Memory framework exists.', status: 'supported', sourceId: 'S1',
      quote: 'Original memory framework exists.' }], sufficient: true, addressesQuestion: true };
  await ai.getResponse([], { sender: 'Тест', text: 'Сыч перепроверь все ссылки', replyText: 'Wrong translator claim.',
    sourceContext: { text: 'Original memory announcement.', urls: ['https://example.org/original'] } });
  assert.match(planner, /Original memory announcement/);
  assert.deepEqual(reads, ['https://example.org/original']);
});

test('a linked-source audit cannot approve a draft about the wrong product or omit unread links', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'The project exists.', url: 'https://example.org/project' }], gaps: [], errors: [],
    requestedSources: [{ url: 'https://example.org/project', status: 'read' }, { url: 'https://example.org/missing', status: 'unavailable' }] };
  ai.reviewEvidence = async () => ({ approved: true, addressesQuestion: false });
  const rejected = await ai.finalizeResearchedAnswer('An unrelated translator.', result);
  assert.doesNotMatch(rejected, /unrelated translator/);
  ai.reviewEvidence = async () => ({ approved: true, addressesQuestion: true });
  const accepted = await ai.finalizeResearchedAnswer('The project exists.', result);
  assert.match(accepted, /example.org\/missing/);
  assert.match(accepted, /прочитать/);
});

test('long original posts keep their initial question in research even with eight long hidden URLs', async () => {
  const { buildSourceContext } = require('../src/utils/source-context');
  const { ai } = harness();
  const sourceContext = buildSourceContext({ from: { id: 1 }, text: 'Сыч, объясни локальный запуск с OpenClaw',
    reply_to_message: { from: { id: 2 }, caption: 'Исходный пост. ' + 'Подробности '.repeat(1100),
      caption_entities: Array.from({ length: 8 }, (_, i) => ({ type: 'text_link', url: `https://example.org/${i}/${'a'.repeat(80)}` })) } });
  const prompts = [];
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.extractUrl = async () => 'The project supports a local server.';
  ai.reviewEvidence = async prompt => {
    prompts.push(prompt);
    return prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА') ? { approved: true, addressesQuestion: true }
      : { claims: [{ claim: 'A local server is supported.', status: 'supported', sourceId: 'S1',
        quote: 'The project supports a local server.' }], sufficient: true, addressesQuestion: true };
  };
  await ai.getResponse([], { sender: 'Тест', text: 'Сыч, ты уверен?', sourceContext });
  const evidenceQuestion = JSON.parse(JSON.parse(prompts[0].split('ВОПРОС И КОНТЕКСТ: ')[1].split('\nИСТОЧНИКИ: ')[0]));
  assert.match(evidenceQuestion.reply, /локальный запуск с OpenClaw/);
});

test('a private query supplies both labelled images and the replied text to the main model', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  await ai.getResponse([], { text: 'Сравни изображения', sender: 'Тест', replyText: 'Исходное сообщение' }, [
    { buffer: Buffer.from('first'), mimeType: 'image/png', label: 'Текущий запрос' },
    { buffer: Buffer.from('second'), mimeType: 'image/jpeg', label: 'Исходный реплай' },
  ]);
  const content = calls[0].messages[1].content;
  assert.equal(content.filter(item => item.type === 'image_url').length, 2);
  assert.match(content[0].text, /Сравни изображения/);
  assert.match(content[0].text, /Исходное сообщение/);
  assert.equal(content.filter(item => item.type === 'text').slice(1).map(item => item.text).join('|'), 'Текущий запрос|Исходный реплай');
});

test('native fallback retains both images and their labels for a private query', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.openai.chat.completions.create = async () => { throw new Error('synthetic unavailable'); };
  ai.keys = ['synthetic'];
  let request;
  ai.nativeModel = { generateContent: async value => {
    request = value;
    return { response: { text: () => 'Сравнение', candidates: [{}] } };
  } };
  await ai.getResponse([], { text: 'Сравни', sender: 'Тест' }, [
    { buffer: Buffer.from('a'), mimeType: 'image/png', label: 'A' },
    { buffer: Buffer.from('b'), mimeType: 'image/jpeg', label: 'B' },
  ]);
  const parts = request.contents[0].parts;
  assert.equal(parts.filter(part => part.inlineData).length, 2);
  assert.equal(parts.filter(part => part.inlineData).map(part => part.inlineData.mimeType).join('|'), 'image/png|image/jpeg');
});

test('private model failures do not send admin messages while public notifications still work', async () => {
  const { runPrivateWork } = require('../src/utils/private-context');
  const { ai, config, notifications } = harness();
  ai.bot = {};
  config.adminId = 999;
  await runPrivateWork(async () => ai.notifyAdmin('synthetic private error'));
  assert.equal(notifications.length, 0);
  ai.notifyAdmin('public status');
  assert.equal(notifications.length, 1);
});

test('private YouTube questions neither read nor populate the shared analysis cache', async () => {
  const { runPrivateWork } = require('../src/utils/private-context');
  let cacheReads = 0;
  const requests = [];
  const { ai } = harness({
    './youtube': { isYouTubeUrl: () => true, selectYoutubeTranscriptMaxChars: () => 1000,
      getYoutubeContext: async () => { throw Error('No subtitles'); } },
    './youtube-gemini': { buildYoutubeGeminiPlan: () => ({ cacheKey: 'synthetic-question' }),
      getCachedYoutubeGeminiAnalysis: () => { cacheReads++; return null; },
      requestYoutubeGeminiAnalysis: async (key, plan, options) => { requests.push(options); return { text: 'Video facts' }; },
      buildYoutubeGeminiPromptContext: () => 'Video facts' },
  });
  ai.keys = ['synthetic'];
  ai.executeNativeWithRetry = fn => fn();
  ai.runLogicModel = async () => ({ needsSearch: false });
  const input = { sender: 'Тест', text: 'Сыч перескажи https://www.youtube.com/watch?v=synthetic' };
  await runPrivateWork(() => ai.getResponse([], input));
  assert.equal(cacheReads, 0);
  assert.equal(requests[0].cache, false);
  await ai.getResponse([], input);
  assert.equal(cacheReads, 1);
  assert.equal(requests[1].cache, true);
});

test('search planning receives the replied claim, even outside the short history', async () => {
  const { ai } = harness();
  let prompt;
  ai.runLogicModel = async p => { prompt = p; return { needsSearch: true, searchQuery: 'Claude supported countries' }; };
  await ai.checkSearchNeeded('А кому из СНГ?', 'unrelated conversation', null, 'Anthropic does not support Kazakhstan.');
  assert.match(prompt, /Anthropic does not support Kazakhstan/);
  assert.match(prompt, /А кому из СНГ/);
});

test('explicit verification cannot be skipped by the classifier or by supplied material', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  await ai.getResponse([], { text: 'Сыч, проверь правдивость этого поста', sender: 'Тест' }, null, undefined, '', null, false, null, 'Unverified article claim');
  assert.match(calls[0].messages[1].content[0].text, /РЕЗУЛЬТАТ ПРОВЕРКИ ИСТОЧНИКОВ/);
});

test('planner failure still searches an explicit request and labels other current answers as unverified', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => null;
  const plan = await ai.checkSearchNeeded('Сыч нагугли ссылку', '', null, 'Claim needing verification');
  assert.equal(plan.needsSearch, true);
  assert.match(plan.searchQuery, /Claim needing verification/);
  await ai.getResponse([], { text: 'Какие цены сейчас?', sender: 'Тест' });
  assert.match(calls[0].messages[1].content[0].text, /подтвердить не удалось/);
});

test('banter skips research and keeps original personality and generation temperature', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.performSearch = async () => { throw Error('Banter must not research'); };
  await ai.getResponse([], { text: 'Сыч, пошути про свой щебетальник', sender: 'Тест' });
  assert.equal(calls[0].temperature, 0.9);
  assert.match(calls[0].messages[0].content, /можешь и послать \(любя\)/);
  assert.match(calls[0].messages[0].content, /используй сленг, мат/);
  assert.doesNotMatch(calls[0].messages[1].content[0].text, /РЕЗУЛЬТАТ ПРОВЕРКИ/);
});

test('writer fallback preserves gathered evidence and disables a new unreviewed search', async () => {
  const { ai } = harness();
  ai.openai.chat.completions.create = async () => { throw Error('writer offline'); };
  ai.keys = ['test'];
  let nativeRequest;
  ai.nativeModel = { generateContent: async request => {
    nativeRequest = request;
    return { response: { text: () => 'Native answer [Источник](https://example.org/countries)', candidates: [{}] } };
  } };
  const answer = await ai.getResponse([], { text: 'Сыч, антропики продают подписки казахам?', sender: 'Тест' });
  assert.equal(answer, 'Native answer [Источник](https://example.org/countries)');
  assert.equal(nativeRequest.tools.length, 0);
  assert.match(nativeRequest.contents[0].parts[0].text, /Kazakhstan supported/);
  assert.match(nativeRequest.contents[0].parts[0].text, /No guarantee for a card/);
  assert.equal(nativeRequest.generationConfig.temperature, 0.9);
});

test('search outage reaches both writers as missing evidence, never silently as a normal factual answer', async () => {
  const { ai, calls } = harness();
  ai.performSearch = async () => [];
  const answer = await ai.getResponse([], { text: 'Сыч проверь новость', sender: 'Тест' });
  assert.match(answer, /Подтвердить .*не удалось/);
  assert.equal(calls.length, 0);
});

test('public composition fails privately instead of returning a research error for publication', async () => {
  const { ai, calls } = harness();
  ai.performSearch = async () => [];
  await assert.rejects(ai.getResponse([], { text: 'Сыч проверь новость', sender: 'Сыч' },
    null, undefined, '', null, false, null, '', { failOnUnavailable: true }), /PUBLIC_RESPONSE_UNAVAILABLE/);
  assert.equal(calls.length, 0);
});

test('public composition rejects unavailable verification in both writer paths', async () => {
  const { ai } = harness();
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА') ? null
    : { claims: [{ claim: 'Kazakhstan supported.', status: 'supported', sourceId: 'S1', quote: 'Kazakhstan is supported for Claude.ai.' }], sufficient: true };
  const input = { text: 'Сыч проверь поддерживаемые страны', sender: 'Сыч' };
  await assert.rejects(ai.getResponse([], input, null, undefined, '', null, false, null, '',
    { failOnUnavailable: true }), /PUBLIC_RESPONSE_UNAVAILABLE/);
  ai.openai.chat.completions.create = async () => { throw Error('Writer offline'); };
  ai.keys = ['synthetic'];
  ai.nativeModel = { generateContent: async () => ({ response: { text: () => 'Draft answer', candidates: [{}] } }) };
  await assert.rejects(ai.getResponse([], input, null, undefined, '', null, false, null, '',
    { failOnUnavailable: true }), /PUBLIC_RESPONSE_UNAVAILABLE/);
});

test('approved researched answers can link to any domain outside the source-page URLs', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'A source reports the project.', status: 'supported', url: 'https://example.org/article' }], gaps: [], errors: [] };
  ai.reviewEvidence = async () => ({ approved: true });
  for (const url of ['https://t.me/abstractDL', 'https://news.example.net/report', 'https://downloads.example.net/release.zip', 'https://another.example.com/Policy_(service)?version=2#section']) {
    const answer = `Вот найденная ссылка: [Открыть](${url}).`;
    assert.equal(await ai.finalizeResearchedAnswer(answer, result), answer);
  }
});

test('Ouroboros Telegram link survives review when its proof is on a different page', async () => {
  const { ai } = harness();
  const result = { question: 'сыч кто урабороса сделал дай ссылку на телегу', claims: [{
    claim: 'Telegram-канал автора проекта Антона Разжигаева — https://t.me/abstractDL.',
    status: 'supported', sourceId: 'S1', url: 'https://habr.com/ru/companies/airi/articles/1065428',
    quote: 'мой Telegram-канал: <https://t.me/abstractDL>',
  }], gaps: [], errors: [] };
  ai.reviewEvidence = async () => ({ approved: true, issues: [], answer: '' });
  const answer = 'Канал Антона Разжигаева: [@abstractDL](https://t.me/abstractDL).';
  assert.equal(await ai.finalizeResearchedAnswer(answer, result), answer);
});

test('answer audit can return a repaired answer with links outside source-page URLs', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'A source identifies the author channel.', status: 'supported', url: 'https://example.org/article' }], gaps: [], errors: [] };
  const repaired = 'Вот канал автора: [Открыть](https://t.me/abstractDL).';
  ai.reviewEvidence = async () => ({ approved: false, answer: repaired });
  assert.equal(await ai.finalizeResearchedAnswer('Wrong draft.', result), repaired);
});

test('failed or invalid answer auditing never releases an unchecked draft', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'Kazakhstan supported.', status: 'supported', url: 'https://example.org/countries' }], gaps: [], errors: [] };
  ai.reviewEvidence = async () => { throw Error('audit offline'); };
  assert.match(await ai.finalizeResearchedAnswer('Definitely banned!', result), /Проверку ответа завершить не удалось/);
  for (const audit of [null, {}, { approved: false, answer: '' }, { approved: 'true' }]) {
    ai.reviewEvidence = async () => audit;
    assert.match(await ai.finalizeResearchedAnswer('Definitely banned!', result), /Проверку ответа завершить не удалось/);
  }
  ai.reviewEvidence = async () => ({ approved: false, answer: 'Один [пост](https://example.org/countries) — ещё не доказательство.' });
  assert.equal(await ai.finalizeResearchedAnswer('Definitely banned!', result), 'Один [пост](https://example.org/countries) — ещё не доказательство.');
});

function timedHarness() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  class ClockDate extends Date { static now() { return now; } }
  const asyncBox = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/async.js'), 'utf8'), {
    module: asyncBox, setTimeout: setTimer, clearTimeout: clearTimer,
  });
  const researchBox = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/research.js'), 'utf8'), {
    module: researchBox, URL, Date: ClockDate, console: { log() {} },
    require: () => asyncBox.exports,
  });
  const context = harness({ '../utils/async': asyncBox.exports, './research': researchBox.exports },
    { Date: ClockDate, setTimeout: setTimer, clearTimeout: clearTimer });
  context.ai.reviewEvidence = Object.getPrototypeOf(context.ai).reviewEvidence.bind(context.ai);
  context.ai.keys = ['synthetic'];
  context.ai.executeNativeWithRetry = fn => fn();
  context.events = [];
  context.delay = (ms, signal, value, reject = false) => new Promise((resolve, fail) => {
    const timer = setTimer(() => reject ? fail(new Error('Request timed out.')) : resolve(value), ms);
    signal?.addEventListener('abort', () => { clearTimer(timer); fail(new Error('aborted')); }, { once: true });
  });
  context.clock = () => now;
  context.drive = async work => {
    let complete = false, value, error;
    work.then(v => { complete = true; value = v; }, e => { complete = true; error = e; });
    for (let n = 0; n < 80 && !complete; n++) {
      await new Promise(setImmediate);
      if (complete) break;
      const first = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
      assert.ok(first, 'pending work must have a bounded timer');
      now = first[1].at; timers.delete(first[0]); first[1].fn();
    }
    assert.ok(complete, 'operation must settle within the bounded schedule');
    if (error) throw error;
    return value;
  };
  return context;
}

test('a slow primary reviewer leaves time for native evidence and final-answer auditing', async () => {
  const context = timedHarness();
  const { ai, events, delay, drive } = context;
  ai.openai.chat.completions.create = (body, options) => {
    if (!options) return Promise.resolve({ choices: [{ message: { content: 'Проверенный ответ [Источник](https://example.org/countries)' } }] });
    events.push({ provider: 'primary', at: context.clock(), timeout: options.timeout, signal: options.signal });
    return delay(options.timeout, options.signal, null, true);
  };
  ai.nativeModel = { generateContent: (request, options) => {
    events.push({ provider: 'native', at: context.clock(), timeout: options?.timeout, signal: options?.signal });
    const audit = request.contents[0].parts[0].text.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА');
    return delay(5000, options?.signal, { response: { text: () => JSON.stringify(audit ? { approved: true } : {
      claims: [{ claim: 'Kazakhstan supported.', status: 'supported', sourceId: 'S1', quote: 'Kazakhstan is supported for Claude.ai.' }], sufficient: true,
    }) } });
  } };
  const answer = await drive(ai.getResponse([], { text: 'Сыч, проверь актуальную информацию', sender: 'Тест' }));
  assert.equal(answer, 'Проверенный ответ [Источник](https://example.org/countries)');
  assert.equal(events.filter(e => e.provider === 'native').length, 2);
  assert.ok(events.every(e => e.signal instanceof AbortSignal));
  assert.ok(events.filter(e => e.provider === 'native').every(e => e.timeout >= 15000));
  assert.ok(context.clock() <= 80000);
});

test('review deadlines abort both providers and shortened caller budgets preserve a native reserve', async () => {
  const context = timedHarness();
  const { ai, events, delay, drive } = context;
  ai.openai.chat.completions.create = (_, options) => {
    events.push(options);
    return delay(100000, options.signal, null);
  };
  ai.nativeModel = { generateContent: (_, options = {}) => {
    events.push(options);
    return delay(100000, options.signal, null);
  } };
  await assert.rejects(drive(ai.reviewEvidence('Synthetic evidence', { timeoutMs: 12000 })), /провер|review/i);
  assert.equal(context.clock(), 12000);
  assert.equal(events.length, 2);
  assert.ok(events[0].timeout <= 5400);
  assert.ok(events[1].timeout >= 6600);
  assert.ok(events.every(e => e.signal?.aborted));
});

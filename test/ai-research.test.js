const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness(extraDependencies = {}) {
  const calls = [];
  const notifications = [];
  const config = { geminiKeys: [], searchProvider: 'tavily', mainModel: 'writer', logicModel: 'planner', maxOutputTokens: 1000 };
  const promptsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/prompts.js'), 'utf8'), { module: promptsModule, require: () => config });
  const dependencies = {
    '../utils/private-context': require('../src/utils/private-context'),
    '@google/generative-ai': {}, '../config': config, '../core/prompts': promptsModule.exports,
    axios: {}, openai: {}, '@tavily/core': {},
    './storage': { initGoogleStats() {}, resetStatsIfNeeded: () => false, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': { sendRich: async (...args) => { notifications.push(args); } }, './youtube': {}, './youtube-gemini': {},
    '../utils/content-policy': require('../src/utils/content-policy'), './research': require('../src/services/research'),
    '../utils/async': require('../src/utils/async'), '../utils/voice': {}, '../utils/reminders': {},
  };
  const box = { exports: {} };
  Object.assign(dependencies, extraDependencies);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8'), {
    module: box, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    console: { log() {}, error() {}, warn() {} }, Buffer, setTimeout, clearTimeout,
  });
  const ai = box.exports;
  ai.openai = { chat: { completions: { create: async request => { calls.push(request); return { choices: [{ message: { content: 'Ответ Сыча [Источник](https://example.org/countries)' } }] }; } } } };
  ai.runLogicModel = async () => ({ needsSearch: true, searchQuery: 'official countries' });
  ai.performSearch = async () => [{ url: 'https://example.org/countries', title: 'Countries', content: 'Kazakhstan is supported for Claude.ai.' }];
  ai.extractUrl = async () => 'Kazakhstan is supported for Claude.ai.';
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА') ? { approved: true } : ({ claims: [{ claim: 'Kazakhstan supported.', status: 'supported', sourceId: 'S1', quote: 'Kazakhstan is supported for Claude.ai.', limitation: 'No guarantee for a card.' }], sufficient: true });
  return { ai, calls, config, notifications };
}

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
  assert.match(answer, /Подтвердить это сейчас не удалось/);
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

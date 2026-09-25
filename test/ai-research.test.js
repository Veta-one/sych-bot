const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness() {
  const calls = [];
  const config = { geminiKeys: [], searchProvider: 'tavily', mainModel: 'writer', logicModel: 'planner', maxOutputTokens: 1000 };
  const promptsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/prompts.js'), 'utf8'), { module: promptsModule, require: () => config });
  const dependencies = {
    '@google/generative-ai': {}, '../config': config, '../core/prompts': promptsModule.exports,
    axios: {}, openai: {}, '@tavily/core': {},
    './storage': { initGoogleStats() {}, resetStatsIfNeeded: () => false, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': {}, './youtube': {}, './youtube-gemini': {},
    '../utils/content-policy': require('../src/utils/content-policy'), './research': require('../src/services/research'),
    '../utils/async': require('../src/utils/async'), '../utils/voice': {}, '../utils/reminders': {},
  };
  const box = { exports: {} };
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
  return { ai, calls, config };
}

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

test('answer audit rejects invented URLs and never releases an unchecked draft on failure', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'Kazakhstan supported.', status: 'supported', url: 'https://example.org/countries' }], gaps: [], errors: [] };
  ai.reviewEvidence = async () => ({ approved: true });
  assert.match(await ai.finalizeResearchedAnswer('Definitely true [proof](https://invented.example.com)', result), /Проверку ответа завершить не удалось/);
  ai.reviewEvidence = async () => { throw Error('audit offline'); };
  assert.match(await ai.finalizeResearchedAnswer('Definitely banned!', result), /Проверку ответа завершить не удалось/);
  ai.reviewEvidence = async () => ({ approved: false, answer: 'Один [пост](https://example.org/countries) — ещё не доказательство.' });
  assert.equal(await ai.finalizeResearchedAnswer('Definitely banned!', result), 'Один [пост](https://example.org/countries) — ещё не доказательство.');
});

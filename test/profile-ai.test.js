const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness({ timeoutCapMs } = {}) {
  const config = { geminiKeys: [], mainModel: 'writer', logicModel: 'logic', maxOutputTokens: 1000 };
  const prompts = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/prompts.js'), 'utf8'), { module: prompts, require: () => config });
  const dependencies = {
    '@google/generative-ai': {}, '../config': config, '../core/prompts': prompts.exports,
    axios: {}, openai: {}, '@tavily/core': {},
    './storage': { initGoogleStats() {}, resetStatsIfNeeded: () => false, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': {}, './youtube': {}, './youtube-gemini': {}, '../utils/content-policy': require('../src/utils/content-policy'), './research': {},
    '../utils/async': { withTimeout: (operation, timeout, label) => require('../src/utils/async').withTimeout(operation,
      timeoutCapMs == null ? timeout : Math.min(timeout, timeoutCapMs), label) }, '../utils/private-context': require('../src/utils/private-context'),
    '../utils/profile-evidence': require('../src/utils/profile-evidence'), '../utils/voice': {}, '../utils/reminders': {},
  };
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8'), {
    module: box, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    console: { log() {}, error() {}, warn() {} }, Buffer, setTimeout, clearTimeout,
  });
  const ai = box.exports;
  const writers = [];
  ai.openai = { chat: { completions: { create: async (request, options) => {
    writers.push({ request, options });
    return { choices: [{ message: { content: 'Он живёт на Марсе.' } }] };
  } } } };
  return { ai, writers };
}

const profile = { userId: 1, relationship: 50, facts: 'Якобы живёт в Риме.', factEvidence: [
  { userId: '1', messageId: '11', quote: 'Я люблю шахматы.' },
] };

test('fabricated dossier rejected by review reaches conservative source quotation, never draft', async () => {
  const { ai, writers } = harness();
  const reviews = [];
  ai.runLogicModel = async (prompt, options) => { reviews.push({ prompt, options }); return { approved: false }; };
  const answer = await ai.generateProfileDescription(profile, 'Тест');
  assert.doesNotMatch(answer, /Марсе/);
  assert.match(answer, /Я люблю шахматы/);
  assert.match(reviews[0].prompt, /НЕПРОВЕРЕНН/i);
  assert.match(reviews[0].prompt, /Я люблю шахматы/);
  assert.equal(reviews[0].options.temperature, 0);
  assert.equal(reviews[0].options.model, 'writer');
  assert.ok(reviews[0].options.timeoutMs > 0);
  assert.equal(writers[0].options.maxRetries, 0);
});

test('reviewed grounded style remains intact; correction needs independent recheck', async () => {
  const { ai } = harness();
  const style = 'Про шахматы говорил сам. Совиный гроссмейстер, ага.';
  ai.openai.chat.completions.create = async () => ({ choices: [{ message: { content: style } }] });
  ai.runLogicModel = async () => ({ approved: true });
  assert.equal(await ai.generateProfileDescription(profile, 'Тест'), style);
  let calls = 0;
  ai.runLogicModel = async () => ++calls === 1 ? { approved: false, answer: 'Любит шахматы, живёт на Марсе.' } : { approved: false, answer: style };
  const rejected = await ai.generateProfileDescription(profile, 'Тест');
  assert.equal(calls, 2);
  assert.doesNotMatch(rejected, /Марсе|гроссмейстер/);
  calls = 0;
  ai.runLogicModel = async () => ++calls === 1 ? { approved: false, answer: style } : { approved: true };
  assert.equal(await ai.generateProfileDescription(profile, 'Тест'), style);
});

test('malformed and failed review or writer always falls back', async () => {
  const { ai } = harness();
  for (const value of [null, {}, { approved: 'true' }, { approved: false, answer: '' }]) {
    ai.runLogicModel = async () => value;
    assert.doesNotMatch(await ai.generateProfileDescription(profile, 'Тест'), /Марсе/);
  }
  ai.runLogicModel = async () => { throw Error('secret raw payload'); };
  assert.doesNotMatch(await ai.generateProfileDescription(profile, 'Тест'), /Марсе|secret/);
  ai.openai.chat.completions.create = async () => { throw Error('offline'); };
  assert.match(await ai.generateProfileDescription(profile, 'Тест'), /Я люблю шахматы/);
});

test('immediate analysis is bound to one user message and can only update relationship', async () => {
  const { ai } = harness();
  let request;
  ai.runLogicModel = async (prompt, options) => { request = { prompt, options }; return { relationship: 51, attitude: 'Доброе общение', facts: 'Марс', location: 'Марс', realName: 'Цезарь' }; };
  const update = await ai.analyzeUserImmediate({ userId: 1, messageId: 10, name: 'А', text: 'Спасибо, Сыч.' }, profile);
  assert.deepEqual(JSON.parse(JSON.stringify(update)), { relationship: 51, attitude: 'Доброе общение' });
  assert.match(request.prompt, /Спасибо, Сыч/);
  assert.doesNotMatch(request.prompt, /Якобы живёт в Риме/);
  assert.match(request.prompt, /userId.*1/);
  assert.equal(request.options.temperature, 0);
  assert.equal(await ai.analyzeUserImmediate('А: Спасибо. Б: Я живу на Марсе.', profile), null);
});

test('batch discards fabricated evidence and model biographies', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ 1: { facts: 'Марс', realName: 'Цезарь', evidence: [
    { messageId: 1, quote: 'Я люблю шахматы.' }, { messageId: 1, quote: 'Живу на Марсе.' },
  ] } });
  const result = await ai.analyzeBatch([{ userId: 1, messageId: 1, name: 'А', text: 'Я люблю шахматы.' }], { 1: profile });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { 1: { factEvidence: [{ userId: '1', messageId: '1', quote: 'Я люблю шахматы.' }] } });
});

test('ordinary and native chat contexts label old memory consistently', async () => {
  const { ai, writers } = harness();
  ai.checkSearchNeeded = async () => ({ needsSearch: false });
  const input = { sender: 'Тест', text: 'Привет' };
  await ai.getResponse([], input, null, undefined, '', profile);
  assert.match(writers[0].request.messages[1].content[0].text, /НЕПРОВЕРЕННАЯ СТАРАЯ ПАМЯТЬ/);
  ai.openai = null;
  ai.executeNativeWithRetry = fn => fn();
  let request;
  ai.nativeModel = { generateContent: async value => { request = value; return { response: { text: () => 'Привет', candidates: [{}] } }; } };
  await ai.getResponse([], input, null, undefined, '', profile);
  assert.match(request.contents[0].parts[0].text, /НЕПРОВЕРЕННАЯ СТАРАЯ ПАМЯТЬ/);
});

test('stalled writer, reviewer and memory analysis obey deadlines and never publish drafts', async () => {
  const { ai } = harness({ timeoutCapMs: 10 });
  let requests = 0;
  ai.openai.chat.completions.create = async () => { requests++; return new Promise(() => {}); };
  const start = Date.now();
  assert.match(await ai.generateProfileDescription(profile, 'Тест'), /Я люблю шахматы/);
  assert.equal(requests, 1);
  ai.openai.chat.completions.create = async () => ({ choices: [{ message: { content: 'Живёт на Марсе.' } }] });
  ai.runLogicModel = async () => new Promise(() => {});
  assert.doesNotMatch(await ai.generateProfileDescription(profile, 'Тест'), /Марсе/);
  assert.equal(await ai.analyzeUserImmediate({ userId: 1, messageId: 1, text: 'Спасибо' }, profile), null);
  assert.deepEqual(JSON.parse(JSON.stringify(await ai.analyzeBatch([{ userId: 1, messageId: 1, text: 'Привет' }], {}))), {});
  assert.ok(Date.now() - start < 2000);
});

test('bounded profile logic disables SDK retries and native search without changing ordinary logic', async () => {
  const { ai } = harness();
  const requests = [];
  ai.openai.chat.completions.create = async (request, options) => { requests.push({ request, options }); throw Error('offline'); };
  ai.keys = ['synthetic'];
  ai.nativeModel = { generateContent: async (request, options) => {
    requests.push({ request, options });
    return { response: { text: () => '{"approved":true}' } };
  } };
  const result = await ai.runLogicModel('synthetic profile source', { temperature: 0, timeoutMs: 1000 });
  assert.equal(result.approved, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.maxRetries, 0);
  assert.ok(requests[0].options.timeout <= 1000);
  assert.ok(requests[1].options.timeout <= 1000);
  assert.equal(requests[1].request.tools.length, 0);
  assert.equal(requests[1].request.generationConfig.temperature, 0);
  assert.doesNotMatch(requests[1].request.systemInstruction.parts[0].text, /Сыч/);
  requests.length = 0;
  ai.openai.chat.completions.create = async (request, options) => {
    requests.push({ request, options }); return { choices: [{ message: { content: '{"ok":true}' } }] };
  };
  await ai.runLogicModel('ordinary logic');
  assert.equal(requests[0].options, undefined);
});

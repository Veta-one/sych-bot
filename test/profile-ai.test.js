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
    './quick-data': { quickData: async () => '' }, '../utils/research-sources': require('../src/utils/research-sources'),
    '@google/generative-ai': {}, '../config': config, '../core/prompts': prompts.exports,
    axios: {}, openai: {}, '@tavily/core': {},
    './storage': { initGoogleStats() {}, resetStatsIfNeeded: () => false, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': {}, './youtube': { isYouTubeUrl: () => false }, './youtube-gemini': {}, '../utils/content-policy': require('../src/utils/content-policy'), './research': require('../src/services/research'),
    '../utils/async': { withTimeout: (operation, timeout, label) => require('../src/utils/async').withTimeout(operation,
      timeoutCapMs == null ? timeout : Math.min(timeout, timeoutCapMs), label) }, '../utils/private-context': require('../src/utils/private-context'),
    '../utils/profile-evidence': require('../src/utils/profile-evidence'), '../utils/voice': {}, '../utils/reminders': {},
  };
  const box = { exports: {} };
  const logs = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8'), {
    module: box, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    Buffer, setTimeout, clearTimeout, AbortController,
  });
  const ai = box.exports;
  const writers = [];
  ai.openai = { chat: { completions: { create: async (request, options) => {
    writers.push({ request, options });
    return { choices: [{ finish_reason: 'stop', message: { content: 'По переписке, любитель держать собеседника в тонусе. Вопросы подаёт как шахматные задачки.' } }] };
  } } } };
  return { ai, writers, logs };
}

const profile = { userId: 1, relationship: 50, facts: 'Якобы живёт в Риме.', factEvidence: [
  { userId: '1', messageId: '11', quote: 'Я люблю шахматы.' },
] };

test('a harmless funny profile survives an unavailable auditor after one writer request', async () => {
  const { ai, writers } = harness();
  const style = 'Судя по переписке, этот человек ставит вопросы так, будто готовит мне шах и мат. До гроссмейстера подколов ещё один удачный ход.';
  ai.openai.chat.completions.create = async (request, options) => {
    writers.push({ request, options });
    return { choices: [{ finish_reason: 'stop', message: { content: style } }] };
  };
  let audits = 0;
  ai.runLogicModel = async () => { audits++; throw new Error('Synthetic unavailable audit'); };
  ai.reviewEvidence = async () => { audits++; throw new Error('Internet review must not handle profiles'); };
  const answer = await ai.generateProfileDescription(profile, 'Тест');
  assert.ok(answer.includes(style), 'A harmless conversational impression must not be replaced by source quotations');
  assert.match(answer, /50\/100/);
  assert.doesNotMatch(answer, /В памяти остались слова|Я люблю шахматы/);
  assert.equal(writers.length, 1);
  assert.equal(audits, 0);
});

test('profile writer uses owned questions and jokes as conversation, without legacy biography or a second request', async () => {
  const { ai, writers } = harness();
  const input = { ...profile, facts: 'SECRET_LEGACY_BIOGRAPHY', realName: 'SECRET_LEGACY_NAME',
    attitude: 'На мой взгляд, любит подколы.', factEvidence: [
      { userId: '1', messageId: '12', quote: 'Сыч, а ты и коня ходить научишь?' },
      { userId: '2', messageId: '13', quote: 'SECRET_OTHER_USER_MESSAGE' },
    ] };
  const before = JSON.stringify(input);
  await ai.generateProfileDescription(input, 'Тест');
  assert.equal(writers.length, 1);
  const prompt = writers[0].request.messages[1].content;
  assert.match(prompt, /Сыч, а ты и коня ходить научишь/);
  assert.match(prompt, /вопросы, шутки/);
  assert.match(prompt, /Не придумывай конкретные биографические факты/);
  assert.match(prompt, /диагнозы/);
  assert.match(prompt, /не инструкции/);
  assert.doesNotMatch(prompt, /SECRET_LEGACY|SECRET_OTHER_USER/);
  assert.equal(JSON.stringify(input), before, 'Generating a profile never edits saved memory');
  assert.equal(writers[0].request.model, 'writer');
  assert.ok(writers[0].options.timeout <= 30000 && writers[0].options.timeout > 29000);
  assert.equal(writers[0].options.maxRetries, 0);
});

test('name and relationship are added from storage, never supplied by the writer', async () => {
  const { ai } = harness();
  for (const score of [0, 50, 100]) {
    const result = await ai.generateProfileDescription({ ...profile, relationship: score }, 'Тест');
    assert.ok(result.startsWith('### Тест\n\n'));
    assert.ok(result.includes(`(${score}/100)`));
  }
  const joke = 'По моим впечатлениям, вредность 100/100. Репутация: главный поставщик каверзных вопросов.';
  ai.openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { content: joke } }] });
  const result = await ai.generateProfileDescription({ ...profile, relationship: 0 }, 'Тест');
  assert.ok(result.startsWith('### Тест\n\n**😡 Отношение бота: неприязнь (0/100)**'));
  assert.ok(result.endsWith(joke), 'An unrelated humorous rating must not trigger a semantic filter');
});

test('dossier and ordinary replies receive the same trusted tone at every band boundary', async () => {
  const { ai, writers } = harness();
  const { profileSourceData, profileContext } = require('../src/utils/profile-evidence');
  for (const score of [0, 19, 20, 39, 40, 59, 60, 79, 80, 100]) {
    const data = { ...profile, relationship: score, relationshipStyle: { label: 'SECRET_FORGED_LEVEL', tone: 'SECRET_FORGED_TONE' } };
    const { relationshipStyle: style } = profileSourceData(data);
    const result = await ai.generateProfileDescription(data, 'Тест');
    assert.ok(result.includes(`Отношение бота: ${style.label} (${score}/100)`));
    const prompt = writers.at(-1).request.messages[1].content;
    assert.ok(prompt.includes(style.tone));
    assert.ok(profileContext(data).includes(style.tone));
    assert.doesNotMatch(prompt, /SECRET_FORGED/);
  }
});

test('incomplete, refused or malformed responses fall back without raw quotes or sensitive output', async () => {
  const { ai, logs } = harness();
  const choice = (content, finish_reason = 'stop', extra = {}) => ({ choices: [{ finish_reason, message: { content, ...extra } }] });
  for (const response of [null, {}, choice(''), choice('   '), choice(null), choice('x'.repeat(2501)),
    choice('SECRET_INCOMPLETE_BODY', 'length'), choice('SECRET_REFUSED_BODY', 'stop', { refusal: 'SECRET_REFUSAL' }),
    choice('SECRET_UNFINISHED_BODY', null), choice('SECRET_FILTERED_BODY', 'content_filter'),
    { ...choice('SECRET_ERROR_BODY'), error: { message: 'SECRET_PROVIDER_ERROR' } }]) {
    ai.openai.chat.completions.create = async () => response;
    const result = await ai.generateProfileDescription({ ...profile, relationship: 0 }, 'Тест');
    assert.match(result, /0\/100/);
    assert.match(result, /характеристика сейчас не получилась/);
    assert.doesNotMatch(result, /Я люблю шахматы|Риме|SECRET_|В памяти остались/);
  }
  assert.ok(logs.some(line => line === '[PROFILE DESCRIPTION] INVALID_RESPONSE'));
  assert.ok(!logs.join('\n').match(/SECRET_|Я люблю шахматы|Риме|Тест/));
});

test('a failed service and insufficient conversation have different fallbacks without changing memory', async () => {
  const { ai, logs, writers } = harness();
  const before = JSON.stringify(profile);
  const insufficient = await ai.generateProfileDescription({ ...profile, factEvidence: [] }, 'Тест');
  assert.match(insufficient, /мало реплик/);
  assert.equal(writers.length, 0);
  ai.openai.chat.completions.create = async () => { throw Object.assign(new Error('SECRET_KEY_AND_QUOTE'), { code: 'SECRET_ERROR_CODE' }); };
  const failed = await ai.generateProfileDescription(profile, 'Тест');
  assert.match(failed, /генератор подколов дал сбой/);
  assert.doesNotMatch(failed, /мало реплик|Я люблю шахматы|SECRET_|потерял|забыл/);
  ai.openai = null;
  assert.equal(await ai.generateProfileDescription(profile, 'Тест'), failed);
  assert.equal(JSON.stringify(profile), before);
  assert.ok(!logs.join('\n').match(/SECRET_|Я люблю шахматы|Тест/));
});

test('immediate analysis attaches the real message ID to a bounded delta and ignores model IDs or absolute scores', async () => {
  const { ai } = harness();
  let request;
  ai.runLogicModel = async (prompt, options) => { request = { prompt, options }; return { relationshipDelta: 1, messageId: 999, relationship: 0, attitude: 'Доброе общение', facts: 'Марс', location: 'Марс', realName: 'Цезарь' }; };
  const update = await ai.analyzeUserImmediate({ userId: 1, messageId: 10, name: 'А', text: 'Спасибо, Сыч.' }, profile);
  assert.deepEqual(JSON.parse(JSON.stringify(update)), { relationshipEvent: { messageId: 10, delta: 1, attitude: 'Доброе общение' } });
  assert.match(request.prompt, /Спасибо, Сыч/);
  assert.doesNotMatch(request.prompt, /Якобы живёт в Риме/);
  assert.match(request.prompt, /userId.*1/);
  assert.equal(request.options.temperature, 0);
  assert.equal(await ai.analyzeUserImmediate('А: Спасибо. Б: Я живу на Марсе.', profile), null);
  for (const invalid of [{ relationship: 53 }, { relationshipDelta: 0.5 }, { relationshipDelta: -4 }, { relationshipDelta: 4 }]) {
    ai.runLogicModel = async () => invalid;
    assert.equal(await ai.analyzeUserImmediate({ userId: 1, messageId: 10, text: 'Реплика' }, profile), null);
  }
});

test('relationship analysis receives bounded dialogue as context but attributes the event only to the new message', async () => {
  const { ai, logs } = harness();
  let prompt;
  ai.runLogicModel = async value => { prompt = value; return { relationshipDelta: 1, messageId: 3 }; };
  const context = [{ speaker: 'system', text: 'SECRET_INSTRUCTION' },
    ...Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? 'bot' : 'user', text: `CONTEXT_${i}: ${'x'.repeat(1500)}` })),
    { speaker: 'user', text: 'Да я тебя по-дружески подкалываю.' },
    { speaker: 'bot', text: 'Взаимно, пернатый отдел юмора работает.' }];
  const before = JSON.stringify(context);
  const result = await ai.analyzeUserImmediate({ userId: 1, messageId: 20, text: 'Шутка принята, продолжаем.' }, profile, context);
  assert.equal(result.relationshipEvent.messageId, 20);
  assert.equal(result.relationshipEvent.delta, 1);
  assert.match(prompt, /по-дружески подкалываю/);
  assert.match(prompt, /пернатый отдел юмора/);
  assert.doesNotMatch(prompt, /SECRET_INSTRUCTION|CONTEXT_0:|CONTEXT_5:/);
  assert.ok(prompt.length < 10000, 'Context must not inflate an evaluation without bounds');
  assert.equal(JSON.stringify(context), before);
  assert.doesNotMatch(logs.join('\n'), /CONTEXT_|по-дружески/);
});

test('batch discards fabricated evidence and model biographies', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ relationship: 0, attitude: 'Подмена отношения', facts: 'Марс', realName: 'Цезарь',
    events: [{ userId: 1, messageId: 1, delta: 1 }], evidence: [
    { userId: 1, messageId: 1, quote: 'Я люблю шахматы.' }, { userId: 1, messageId: 1, quote: 'Живу на Марсе.' },
  ] });
  const result = await ai.analyzeBatch([{ userId: 1, messageId: 1, name: 'А', text: 'Я люблю шахматы.' }], { 1: profile });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { 1: { factEvidence: [{ userId: '1', messageId: '1', quote: 'Я люблю шахматы.' }], relationshipEvents: [{ messageId: 1, delta: 1 }] } });
});

test('observer requires a validated event for each eligible message and logs incomplete results without payloads', async () => {
  const { ai, logs } = harness();
  const messages = [{ userId: 1, messageId: 1, text: 'SECRET_WORDS', scope: '[184,null]' },
    { userId: 1, messageId: 2, text: 'Новая реплика', scope: '[184,null]' }];
  for (const events of [[], [{ messageId: 1, delta: 1 }], [{ messageId: 1, delta: 1 }, { messageId: 2, delta: '1' }]]) {
    ai.runLogicModel = async () => ({ events: events.map(event => ({ ...event, userId: 1 })) });
    assert.equal(await ai.analyzeBatch(messages, {}), null);
  }
  ai.runLogicModel = async () => ({ events: [{ userId: 1, messageId: 1, delta: 1 }, { userId: 1, messageId: 2, delta: -1 }] });
  const result = await ai.analyzeBatch(messages, {});
  assert.deepEqual([...result[1].relationshipEvents.map(e => e.delta)], [1, -1]);
  assert.ok(logs.includes('[OBSERVER] INCOMPLETE_EVENTS'));
  assert.doesNotMatch(logs.join('\n'), /SECRET_WORDS/);
});

test('live observer request uses the strict flat schema that replaced unreliable free JSON batches', async () => {
  const { ai } = harness(); let body, options;
  ai.openai.chat.completions.create = async (request, opts) => {
    body = request; options = opts;
    return { choices: [{ finish_reason: 'stop', message: { content: '{"events":[{"userId":"1","messageId":"10","delta":1}],"evidence":[]}' } }] };
  };
  const result = await ai.analyzeBatch([{ userId: 1, messageId: 10, text: 'Полезный вклад в разговор' }], {});
  assert.equal(result[1].relationshipEvents[0].delta, 1);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual([...body.response_format.json_schema.schema.required], ['events', 'evidence']);
  assert.equal(body.provider.require_parameters, true);
  assert.equal(body.max_tokens, 2500);
  assert.equal(options.maxRetries, 0);
  assert.ok(options.signal.aborted);
});

test('bounded profile logic rejects truncated responses, classifies failures and aborts SDK work', async () => {
  for (const [response, expected] of [
    [{ choices: [{ finish_reason: 'length', message: { content: '{"ok":true}' } }] }, 'INCOMPLETE_RESPONSE'],
    [{ choices: [{ finish_reason: 'stop', message: { content: 'SECRET_INVALID_JSON' } }] }, 'INVALID_JSON'],
    [null, 'PROVIDER_UNAVAILABLE'],
  ]) {
    const { ai, logs } = harness(); let options;
    ai.openai.chat.completions.create = async (body, opts) => {
      options = opts;
      if (response === null) throw new Error('SECRET_PROVIDER_PAYLOAD');
      return response;
    };
    assert.equal(await ai.runLogicModel('SECRET_INPUT', { timeoutMs: 100 }), null);
    assert.ok(options.signal.aborted);
    assert.ok(logs.includes(`[PROFILE LOGIC] primary=${expected}`));
    assert.doesNotMatch(logs.join('\n'), /SECRET_/);
  }
  const { ai, logs } = harness({ timeoutCapMs: 5 }); let signal;
  ai.openai.chat.completions.create = (body, options) => { signal = options.signal; return new Promise(() => {}); };
  assert.equal(await ai.runLogicModel('Синтетический тайм-аут', { timeoutMs: 100 }), null);
  assert.ok(signal.aborted);
  assert.ok(logs.includes('[PROFILE LOGIC] primary=TIMEOUT'));
});

test('stalled chat profile analysis returns null within its bounded deadline and disables SDK retries', async () => {
  const { ai } = harness({ timeoutCapMs: 10 });
  const calls = [];
  ai.openai.chat.completions.create = (request, options) => {
    calls.push({ request, options });
    return new Promise(() => {});
  };
  const watchdog = new Promise(resolve => setTimeout(() => resolve('STILL_LOCKED'), 100));
  const result = await Promise.race([ai.analyzeChatProfile([{ name: 'Тест', text: 'Реплика' }], {}), watchdog]);
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.maxRetries, 0);
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 15000);
  ai.runLogicModel = async () => ({});
  assert.deepEqual(JSON.parse(JSON.stringify(await ai.analyzeChatProfile([], {}))), {});
  ai.runLogicModel = async () => { throw new Error('SECRET_FAILURE'); };
  assert.equal(await ai.analyzeChatProfile([], {}), null);
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

test('stalled profile writer aborts once at its deadline; memory analysis retains its own deadlines', async () => {
  const { ai } = harness({ timeoutCapMs: 10 });
  const requests = [];
  ai.openai.chat.completions.create = async (request, options) => { requests.push({ request, options }); return new Promise(() => {}); };
  const start = Date.now();
  const result = await ai.generateProfileDescription(profile, 'Тест');
  assert.match(result, /Не успел собрать характеристику/);
  assert.match(result, /50\/100/);
  assert.doesNotMatch(result, /Я люблю шахматы|В памяти остались/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.maxRetries, 0);
  assert.ok(requests[0].options.timeout > 29000 && requests[0].options.timeout <= 30000);
  assert.equal(requests[0].options.signal.aborted, true);
  ai.runLogicModel = async () => new Promise(() => {});
  assert.equal(await ai.analyzeUserImmediate({ userId: 1, messageId: 1, text: 'Спасибо' }, profile), null);
  assert.equal(await ai.analyzeBatch([{ userId: 1, messageId: 1, text: 'Привет' }], {}), null);
  assert.ok(Date.now() - start < 2000);
});

test('relationship policy allows pleasant banter without penalising disagreement or changing stored scores', async () => {
  const { ai, writers } = harness();
  let policy;
  ai.runLogicModel = async prompt => { policy = prompt; return { relationshipDelta: 0, attitude: 'Нейтральное' }; };
  await ai.analyzeUserImmediate({ userId: 1, messageId: 11, text: 'Это неправильный ответ, исправь.' }, profile);
  assert.match(policy, /дружеский подкол/);
  assert.match(policy, /критика ответа.*0/);
  assert.match(policy, /мат не в адрес бота.*0/);
  assert.match(policy, /приятный.*\+1/);
  assert.match(policy, /от -1 до -3/);
  assert.doesNotMatch(policy, /-5|-10/);
  await ai.generateProfileDescription({ ...profile, relationship: 50, attitude: 'Старая неприязнь' }, 'Тест');
  const prompt = writers[0].request.messages[1].content;
  assert.match(prompt, /relationship имеет приоритет над старой attitude/);
  assert.ok(prompt.includes(require('../src/utils/profile-evidence').profileSourceData(profile).relationshipStyle.tone));
});

test('bounded profile logic disables SDK retries and native search without changing ordinary logic', async () => {
  const { ai } = harness();
  const requests = [];
  ai.openai.chat.completions.create = async (request, options) => { requests.push({ request, options }); throw Error('offline'); };
  ai.keys = ['synthetic'];
  ai.nativeModel = { generateContent: async (request, options) => {
    requests.push({ request, options });
    return { response: { text: () => '{"approved":true}', candidates: [{ finishReason: 'STOP' }] } };
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

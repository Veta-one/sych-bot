const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { withTimeout } = require('../src/utils/async');
const voice = require('../src/utils/voice');

function loadModule(file, dependencies, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    module, Buffer, console: { log() {}, warn() {}, error() {} },
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return module.exports;
}

function loadAi({ transcript = 'Уточни адрес, пожалуйста.', summary = 'Краткий ответ.', reviewedSummary, summaryError, reviewError, rawTranscript, rawSummary, stall = false, reviewStall = false, quotaOnce = false, keys = ['test-key'], api = true } = {}) {
  const calls = [], models = [];
  const config = { geminiKeys: keys, googleNativeModel: 'test-voice-model', mainModel: 'test-main-model', aiKey: api ? 'test' : '' };
  const prompts = loadModule('core/prompts.js', { '../config': config });
  class FakeGoogle {
    constructor(key) { this.key = key; }
    getGenerativeModel(options) {
      models.push(options);
      const field = options.generationConfig?.responseSchema?.required[0];
      return { generateContent: async (input, requestOptions) => {
        calls.push({ field, input, requestOptions, key: this.key });
        if (quotaOnce && calls.length === 1) throw new Error('429 quota exceeded');
        if (field === 'summary') {
          if (stall) return new Promise(() => {});
          if (summaryError) throw summaryError;
        }
        const body = field === 'text' ? (rawTranscript ?? JSON.stringify({ text: transcript }))
          : (rawSummary ?? JSON.stringify({ summary }));
        return { response: { text: () => body } };
      } };
    }
  }
  class FakeOpenAI {
    constructor() {
      let requests = 0;
      this.chat = { completions: { create: async (options, requestOptions) => {
        const review = ++requests > 1;
        calls.push({ field: review ? 'review' : 'summary', input: options.messages[1].content, options, requestOptions });
        if (stall || (review && reviewStall)) return new Promise(() => {});
        if (summaryError) throw summaryError;
        if (review && reviewError) throw reviewError;
        const body = rawSummary ?? JSON.stringify({ summary: review ? (reviewedSummary ?? summary) : summary });
        return { choices: [{ message: { content: body } }] };
      } } };
    }
  }
  const ai = loadModule('services/ai.js', {
    '@google/generative-ai': { GoogleGenerativeAI: FakeGoogle, HarmCategory: {}, HarmBlockThreshold: {} },
    '../config': config, '../core/prompts': prompts, axios: {}, openai: FakeOpenAI, '@tavily/core': {},
    './storage': { initGoogleStats() {}, incrementGoogleStat() {}, markGoogleKeyExhausted() {}, incrementStat() {} },
    '../utils/rich': {}, './youtube': {}, './youtube-gemini': {}, '../utils/content-policy': {}, './research': {},
    '../utils/voice': voice,
    '../utils/reminders': require('../src/utils/reminders'),
    '../utils/async': { withTimeout: (operation, timeout, label) => withTimeout(operation, stall || reviewStall ? 15 : timeout, label) },
  });
  return { ai, calls, models };
}

const longTranscript = 'Если заберу машину, возможно, приеду завтра к 19:00. Иначе в субботу. Уточни адрес. '
  + 'Объясняю, почему пока не могу обещать: время выдачи машины ещё не подтвердили. '.repeat(12);
const usefulSummary = 'Возможно, приеду завтра к 19:00, если заберу машину. Иначе — в субботу. Уточни адрес.';

test('up to 700 characters uses one neutral audio request and never summarizes', async () => {
  for (const text of ['Уточни адрес.', 'я'.repeat(700)]) {
    const { ai, calls, models } = loadAi({ transcript: text });
    const result = await ai.transcribeAudio(Buffer.from('audio'), 'Имя', 'audio/ogg');
    assert.equal(result.text, text);
    assert.equal(result.summary, undefined);
    assert.equal(calls.length, 1);
    assert.equal(await ai.summarizeVoiceTranscript(text), '');
    assert.equal(calls.length, 1, 'short text never calls the main summary model');
    assert.equal(calls[0].field, 'text');
    assert.equal(calls[0].input[0].inlineData.mimeType, 'audio/ogg');
    const chatModel = models.find(model => model.tools);
    for (const model of models.filter(model => model.generationConfig)) {
      assert.equal(model.tools, undefined);
      assert.notEqual(model.systemInstruction, chatModel.systemInstruction);
      assert.equal(model.generationConfig.responseMimeType, 'application/json');
    }
  }
});

test('long voice gets a separate text-only summary request using the complete transcript', async () => {
  const { ai, calls } = loadAi({ transcript: longTranscript, summary: usefulSummary });
  const result = await ai.transcribeAudio(Buffer.from('audio'), 'Имя', 'audio/ogg');
  assert.equal(result.text, longTranscript.trim());
  assert.equal(calls.length, 1, 'recognition does not summarize before routing');
  result.summary = await ai.summarizeVoiceTranscript(result.text, 'Имя');
  assert.equal(result.summary, usefulSummary);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].field, 'summary');
  assert.equal(typeof calls[1].input, 'string');
  assert.ok(calls[1].input.includes(JSON.stringify(result.text)));
  assert.ok(calls[1].requestOptions.timeout <= 20000);
  assert.equal(calls[1].options.model, 'test-main-model');
  assert.equal(calls[1].requestOptions.maxRetries, 0);
  assert.equal(calls[1].options.tools, undefined);
  assert.equal(JSON.parse(calls[1].input).speaker, 'Имя');
  assert.equal(calls[2].field, 'review');
  assert.equal(JSON.parse(calls[2].input).transcript, result.text);
  assert.equal(calls[2].options.model, 'test-main-model');
  assert.ok(calls[2].requestOptions.timeout <= calls[1].requestOptions.timeout);
});

test('summary errors, bad JSON, wrong types, empty output, and stalls preserve the transcript', async () => {
  for (const failure of [{ summaryError: new Error('503 unavailable') }, { rawSummary: 'not JSON' },
    { rawSummary: '{"summary":42}' }, { summary: '' }, { stall: true }]) {
    const { ai } = loadAi({ transcript: longTranscript, ...failure });
    const result = await ai.transcribeAudio(Buffer.from('audio'), 'Имя', 'audio/ogg');
    result.summary = await ai.summarizeVoiceTranscript(result.text);
    assert.equal(result.text, longTranscript.trim());
    assert.equal(result.summary, '');
  }
});

test('inefficient or oversized summaries are rejected whole, never cut mid-condition', async () => {
  for (const [text, summary] of [['т'.repeat(701), 'с'.repeat(351)], ['т'.repeat(2000), 'с'.repeat(361)]]) {
    const { ai } = loadAi({ transcript: text, summary });
    const result = await ai.transcribeAudio(Buffer.from('audio'), 'Имя', 'audio/ogg');
    result.summary = await ai.summarizeVoiceTranscript(result.text);
    assert.equal(result.text, text);
    assert.equal(result.summary, '');
  }
  assert.equal(voice.selectVoiceSummary('т'.repeat(800), 'с'.repeat(360)).length, 360);
  assert.equal(voice.shouldSummarizeVoice('т'.repeat(701)), true);
});

test('only reviewed summaries are published, with one opportunity to shorten an oversized draft', async () => {
  const { ai, calls } = loadAi({ summary: 'д'.repeat(800), reviewedSummary: usefulSummary });
  assert.equal(await ai.summarizeVoiceTranscript(longTranscript), usefulSummary);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].input).draft.length, 800);
  for (const failure of [{ reviewError: new Error('503') }, { reviewStall: true }, { reviewedSummary: '' }, { api: false }]) {
    const instance = loadAi({ summary: usefulSummary, ...failure });
    assert.equal(await instance.ai.summarizeVoiceTranscript(longTranscript), '');
    assert.ok(instance.calls.every(call => call.field !== 'text'), 'no native-model fallback');
  }
});

test('quota rotation recreates the dedicated voice model on the next key', async () => {
  const { ai, calls } = loadAi({ quotaOnce: true, keys: ['key-one', 'key-two'] });
  const result = await ai.transcribeAudio(Buffer.from('audio'), 'Имя', 'audio/ogg');
  assert.ok(result.text);
  assert.deepEqual(calls.map(call => [call.field, call.key]), [['text', 'key-one'], ['text', 'key-two']]);
});

test('missing or invalid transcripts never produce invented summaries', async () => {
  for (const rawTranscript of ['{}', '{"text":42}', '{"text":"  "}', 'broken']) {
    const { ai, calls } = loadAi({ rawTranscript });
    assert.equal(await ai.transcribeAudio(Buffer.from('audio'), 'Имя', 'audio/ogg'), null);
    assert.equal(calls.length, 1);
  }
  const { ai, calls } = loadAi({ keys: [] });
  assert.equal(await ai.transcribeAudio(Buffer.from('audio'), 'Имя', 'audio/ogg'), null);
  assert.equal(calls.length, 0);
});

const rich = loadModule('utils/rich.js', { axios: {}, '../config': {}, './voice': voice, './quotes': require('../src/utils/quotes') });

test('voice cards escape user content, preserve paragraphs and show the full transcript', () => {
  const short = rich.formatVoiceMessage({ text: 'Не <удаляй> & сохрани.\nУточни адрес.', summary: 'Нельзя скрывать короткий текст.' }, '<Имя>', 67);
  assert.doesNotMatch(short.html, /Имя|1:07|🎙|Кратко:/);
  assert.match(short.html, /&lt;удаляй&gt; &amp; сохрани\.<br\/>Уточни адрес/);
  assert.doesNotMatch(short.html, /<details>|Кратко:/);
  assert.match(short.html, /<blockquote expandable>/);
  const long = rich.formatVoiceMessage({ text: longTranscript, summary: usefulSummary + '\n• Ничего <не обещаю>.' }, 'Имя', 145);
  assert.match(long.html, /<details><summary>Расшифровка<\/summary><blockquote>/);
  assert.doesNotMatch(long.html, /expandable/);
  assert.doesNotMatch(long.html, /Имя|2:25|🎙|Кратко:/);
  assert.match(long.html, /<br\/>• Ничего &lt;не обещаю&gt;/);
  assert.ok(long.html.includes(longTranscript));
  const fallback = rich.formatVoiceMessage({ text: longTranscript, summary: '' }, 'Имя');
  assert.doesNotMatch(fallback.html, /expandable|Кратко:/);
  assert.match(fallback.html, /<details><summary>Расшифровка<\/summary><blockquote>/);
  assert.ok(fallback.html.includes(longTranscript));
});

test('message handler sends one voice card in the original topic and preserves full text for context', async () => {
  const sent = [];
  const speakers = [];
  const result = { text: longTranscript, summary: usefulSummary };
  const handler = loadModule('core/logic.js', {
    '../services/storage': { isBanned: () => false, hasChat: () => true, updateChatName() {},
      trackUser() {}, isTopicMuted: () => false, getChatProfile: () => ({ topic: 'test' }) },
    '../services/ai': { transcribeAudio: async () => result, summarizeVoiceTranscript: async (text, speaker) => { speakers.push(speaker); return usefulSummary; } },
    '../config': { adminId: 999, botId: 888, triggerRegex: /сыч|sych/i, contextSize: 30 },
    axios: { get: async () => ({ data: Buffer.from('audio') }) }, child_process: {},
    '../utils/rich': { ...rich, sendRich: async (...args) => { sent.push(args); } },
    '../utils/privacy': { isForgetMeRequest: () => false }, '../utils/profile-query': {},
    '../utils/commands': {}, '../services/documents': {},
    '../utils/reminders': require('../src/utils/reminders'),
  }, { setTimeout, clearTimeout, setInterval, clearInterval, Math: { ...Math, random: () => 1 } });
  const msg = { message_id: 10, from: { id: 999, first_name: 'Имя' },
    chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 184,
    voice: { file_id: 'test', duration: 80 } };
  await handler.processMessage({ getFileLink: async () => 'mock://audio', sendChatAction: async () => {} }, msg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], -100);
  assert.equal(sent[0][3].threadId, 184);
  assert.equal(sent[0][3].replyTo, 10);
  assert.equal(msg.text, longTranscript);
  assert.deepEqual(speakers, ['Имя']);
  await handler.processMessage({ getFileLink: async () => 'mock://audio', sendChatAction: async () => {} }, {
    ...msg, message_id: 11, text: undefined, forward_origin: { type: 'hidden_user', sender_user_name: 'Другой человек' },
  });
  assert.deepEqual(speakers, ['Имя', ''], 'a forwarded recording is not attributed to its sender');
});

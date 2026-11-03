const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { withTimeout } = require('../src/utils/async');

function load(file, dependencies, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    module, Buffer, URL, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}

function loadConfig(env = {}) {
  return load('config.js', {
    '../package.json': { version: 'test' }, dotenv: { config() {} },
  }, { process: { env: { TELEGRAM_BOT_TOKEN: '123:test-token', ...env } } });
}

function loadAi({ provider = 'openrouter', keys = [], response, error, stall = false } = {}) {
  const config = loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: provider, OPENROUTER_API_KEY: 'synthetic-key' });
  config.geminiKeys = keys;
  const calls = [], nativeCalls = [], logs = [], clients = [], timeouts = [], stats = [];
  const prompts = load('core/prompts.js', { '../config': config });
  class FakeGoogle {
    getGenerativeModel() {
      return { generateContent: async (...args) => {
        nativeCalls.push(args);
        throw new Error('Native requests must not be used in this test');
      } };
    }
  }
  class FakeOpenAI {
    constructor(options) {
      clients.push(options);
      this.chat = { completions: { create: async (body, requestOptions) => {
        calls.push({ body, requestOptions });
        if (stall) return new Promise(() => {});
        if (error) throw error;
        return response ?? { choices: [{ finish_reason: 'stop', message: { content: '{"text":"Уточни адрес."}' } }] };
      } } };
    }
  }
  const ai = load('services/ai.js', {
    '@google/generative-ai': { GoogleGenerativeAI: FakeGoogle, HarmCategory: {}, HarmBlockThreshold: {} },
    '../config': config, '../core/prompts': prompts, axios: {}, openai: FakeOpenAI, '@tavily/core': {},
    './storage': { initGoogleStats() {}, incrementGoogleStat() {}, incrementStat(name) { stats.push(name); } },
    '../utils/rich': {}, './youtube': {}, './youtube-gemini': {}, '../utils/content-policy': {}, './research': {},
    '../utils/private-context': require('../src/utils/private-context'),
    '../utils/profile-evidence': require('../src/utils/profile-evidence'),
    '../utils/voice': require('../src/utils/voice'),
    '../utils/reminders': require('../src/utils/reminders'),
    '../utils/async': { withTimeout(operation, timeout, label) {
      timeouts.push(timeout);
      return withTimeout(operation, stall ? 5 : timeout, label);
    } },
  }, { console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  return { ai, calls, nativeCalls, logs, clients, timeouts, prompts, stats };
}

test('voice provider defaults to Google and rejects an unknown value at startup', () => {
  assert.equal(loadConfig().voiceTranscriptionProvider, 'google');
  assert.equal(loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: 'google' }).voiceTranscriptionProvider, 'google');
  assert.equal(loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: 'off' }).voiceTranscriptionProvider, 'off');
  assert.throws(() => loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: 'typo-secret' }), error =>
    error.message.includes('VOICE_TRANSCRIPTION_PROVIDER') && !error.message.includes('typo-secret'));
});

test('OpenRouter startup requires the shared key and an actual OpenRouter endpoint', () => {
  assert.throws(() => loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: 'openrouter' }), /OPENROUTER_API_KEY|AI_API_KEY/);
  for (const value of ['https://openrouter.ai.evil.test/api/v1', 'http://openrouter.ai/api/v1',
    'https://openrouter.ai:444/api/v1', 'https://secret@openrouter.ai/api/v1',
    'https://openrouter.ai/api/v1?secret=key', 'https://openrouter.ai/api/v1#secret',
    'https://other-provider.test/api/v1', 'not-a-url']) {
    assert.throws(() => loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: 'openrouter', AI_API_KEY: 'synthetic', AI_BASE_URL: value }), error =>
      error.message.includes('AI_BASE_URL') && !error.message.includes(value));
  }
  for (const value of ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/']) {
    const config = loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: 'openrouter', AI_API_KEY: 'synthetic', AI_BASE_URL: value });
    assert.equal(config.voiceTranscriptionProvider, 'openrouter');
    assert.equal(config.aiKey, 'synthetic');
  }
  // Existing custom text endpoints remain valid when native voice or off is selected.
  for (const provider of ['google', 'off']) {
    assert.equal(loadConfig({ VOICE_TRANSCRIPTION_PROVIDER: provider, AI_BASE_URL: 'https://other-provider.test/v1' }).voiceTranscriptionProvider, provider);
  }
});

test('OpenRouter transcribes OGG/Opus and WAV without Google keys through the shared text client', async () => {
  for (const [mime, format] of [['audio/ogg', 'ogg'], ['audio/ogg; codecs=opus', 'ogg'], ['audio/opus', 'ogg'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav']]) {
    const { ai, calls, nativeCalls, clients, prompts, stats } = loadAi();
    const buffer = Buffer.from('synthetic audio fixture');
    const result = await ai.transcribeAudio(buffer, 'Тест', mime);
    assert.equal(result?.text, 'Уточни адрес.');
    assert.equal(calls.length, 1);
    assert.deepEqual(stats, ['smart']);
    assert.equal(nativeCalls.length, 0);
    assert.equal(clients.length, 1, 'the existing text client is reused');
    assert.equal(clients[0].apiKey, 'synthetic-key');
    const { body, requestOptions } = calls[0];
    assert.equal(body.model, 'google/gemini-2.5-flash-lite');
    assert.equal(body.messages[0].content, prompts.voiceTranscriptionSystem());
    const parts = body.messages[1].content;
    assert.equal(parts.find(part => part.type === 'input_audio').input_audio.data, buffer.toString('base64'));
    assert.equal(parts.find(part => part.type === 'input_audio').input_audio.format, format);
    assert.equal(parts.find(part => part.type === 'text').text, prompts.transcription('Тест'));
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.properties.text.type, 'string');
    assert.equal(body.reasoning.enabled, false);
    assert.ok(body.max_tokens > 0 && body.max_tokens <= 8192);
    assert.equal(requestOptions.maxRetries, 0);
    assert.ok(requestOptions.timeout > 0 && requestOptions.timeout <= 60000);
    assert.ok(requestOptions.signal, 'the operation can be cancelled when the deadline expires');
  }
});

test('OpenRouter rejects invalid input without any provider request', async () => {
  for (const [buffer, mime] of [[null, 'audio/ogg'], [new Uint8Array([1]), 'audio/ogg'],
    [Buffer.alloc(0), 'audio/ogg'], [Buffer.alloc(20 * 1024 * 1024 + 1), 'audio/ogg'],
    [Buffer.from('audio'), 'text/plain'], [Buffer.from('audio'), null]]) {
    const { ai, calls, nativeCalls } = loadAi({ keys: ['unused-google-key'] });
    assert.equal(await ai.transcribeAudio(buffer, 'Тест', mime), null);
    assert.equal(calls.length, 0);
    assert.equal(nativeCalls.length, 0);
  }
});

test('OpenRouter errors and malformed or truncated responses never fall back to Google or leak payloads', async () => {
  const secret = 'synthetic-sensitive-transcript-and-key';
  const choices = (content, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });
  for (const failure of [
    { error: Object.assign(new Error(secret), { status: 429, code: secret, response: { body: secret } }) },
    { error: Object.assign(new Error(secret), { status: 503 }) },
    { response: choices(JSON.stringify({ text: secret }), 'length') },
    { response: choices(JSON.stringify({ text: secret }), 'content_filter') },
    { response: choices(secret) },
    { response: choices('{"text":42}') },
    { response: choices('{"text":"  "}') },
    { response: { choices: [], error: { message: secret } } },
  ]) {
    const { ai, calls, nativeCalls, logs, stats } = loadAi({ keys: ['unused-google-key'], ...failure });
    assert.equal(await ai.transcribeAudio(Buffer.from('audio'), 'Тест', 'audio/ogg'), null);
    assert.equal(calls.length, 1);
    assert.equal(nativeCalls.length, 0);
    assert.deepEqual(stats, failure.error ? [] : ['smart'], 'completed responses are counted even when their content is unusable');
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.ok(logs.some(args => args.some(value => String(value).includes('TRANSCRIPTION'))));
  }
});

test('OpenRouter timeout aborts the in-flight request and never starts a native fallback', async () => {
  const { ai, calls, nativeCalls, timeouts, logs, stats } = loadAi({ stall: true, keys: ['unused-google-key'] });
  assert.equal(await ai.transcribeAudio(Buffer.from('audio'), 'Тест', 'audio/ogg'), null);
  assert.equal(calls.length, 1);
  assert.equal(nativeCalls.length, 0);
  assert.deepEqual(stats, []);
  assert.equal(calls[0].requestOptions.signal.aborted, true);
  assert.ok(timeouts.length > 0 && timeouts.every(value => value > 0 && value <= 60000));
  assert.ok(JSON.stringify(logs).includes('TIMEOUT'));
});

test('off makes no transcription API call even with both providers configured', async () => {
  const { ai, calls, nativeCalls, stats } = loadAi({ provider: 'off', keys: ['unused-google-key'] });
  assert.equal(await ai.transcribeAudio(Buffer.from('audio'), 'Тест', 'audio/ogg'), null);
  assert.equal(calls.length, 0);
  assert.equal(nativeCalls.length, 0);
  assert.deepEqual(stats, []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { readableLength, shouldAutoTldr, validTldr, AutoTldrJobs } = require('../src/utils/auto-tldr');

const prose = 'Автор описывает новый способ сохранять контекст задачи и объясняет условия подключения. '.repeat(15);
const message = overrides => ({ message_id: 1, chat: { id: -100, type: 'supergroup' },
  from: { id: 42 }, text: prose, ...overrides });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);

test('a long human group post qualifies without a trigger, including captions and forwards', () => {
  assert.equal(shouldAutoTldr(message()), true);
  assert.equal(shouldAutoTldr(message({ text: undefined, caption: prose, photo: [{}] })), true);
  assert.equal(shouldAutoTldr(message({ forward_origin: { type: 'channel' } })), true);
  const characters = readableLength(message()).characters;
  assert.equal(shouldAutoTldr(message(), { threshold: characters }), true);
  assert.equal(shouldAutoTldr(message(), { threshold: characters + 1 }), false);
});

test('URL length, whitespace, formatted code and emoji surrogate pairs do not inflate readability', () => {
  assert.equal(readableLength({ text: 'A  🦉  B' }).characters, 5);
  assert.equal(shouldAutoTldr(message({ text: 'https://example.org/' + 'a'.repeat(2000) })), false);
  assert.equal(shouldAutoTldr(message({ text: ' \n '.repeat(1500) })), false);
  assert.equal(shouldAutoTldr(message({ entities: [{ type: 'pre', offset: 0, length: prose.length }] })), false);
  assert.equal(shouldAutoTldr(message({ text: 'x'.repeat(2000) })), false);
});

test('private, edited, bot, command, ephemeral, voice and directly addressed messages stay on their existing paths', () => {
  for (const overrides of [{ chat: { id: 42, type: 'private' } }, { from: { id: 888, is_bot: true } },
    { edit_date: 123 }, { ephemeral_message_id: 7 }, { reply_to_message: { ephemeral_message_id: 8 } },
    { voice: {} }, { audio: {} }, { text: '/command ' + prose }, { message_id: 0 }]) {
    assert.equal(shouldAutoTldr(message(overrides)), false);
  }
  assert.equal(shouldAutoTldr(message(), { directlyCalled: true }), false);
  assert.equal(shouldAutoTldr(message(), { enabled: false }), false);
  assert.equal(shouldAutoTldr(message({ text: prose.repeat(40) })), false);
});

test('only a bounded short paragraph is accepted without truncating meaning', () => {
  assert.equal(validTldr(' Краткая суть.\nПолезно разработчикам. ', prose), 'Краткая суть. Полезно разработчикам.');
  assert.equal(validTldr('x'.repeat(451), prose), '');
  assert.equal(validTldr('Too much text for the source.', 'tiny'), '');
});

test('concurrent redelivery and ambiguous delivery never start a duplicate attempt', async () => {
  const jobs = new AutoTldrJobs();
  const gate = defer(); let calls = 0;
  const first = jobs.run(message(), 4, async () => { calls++; await gate.promise; throw Error('ambiguous'); });
  await flush();
  assert.equal(await jobs.run(message(), 4, () => { calls++; }), 'duplicate');
  gate.resolve(); assert.equal(await first, 'failed');
  assert.equal(await jobs.run(message(), 4, () => { calls++; }), 'duplicate');
  assert.equal(calls, 1);
});

test('independent messages are queued under a global concurrency bound and the queue has a cap', async () => {
  const jobs = new AutoTldrJobs({ concurrency: 1, maxPending: 2 });
  const gate = defer(); const order = [];
  const first = jobs.run(message(), 1, async () => { order.push(1); await gate.promise; return true; });
  const second = jobs.run(message({ message_id: 2 }), 1, async () => { order.push(2); return true; });
  assert.equal(await jobs.run(message({ message_id: 3 }), 1, async () => true), 'capacity');
  await flush(); assert.deepEqual(order, [1]);
  gate.resolve(); assert.equal(await first, 'delivered'); assert.equal(await second, 'delivered');
  assert.deepEqual(order, [1, 2]);
});

test('forget/reset cancel queued and in-flight work, scopes stay separate, and attempt records expire', async () => {
  let now = 0;
  const jobs = new AutoTldrJobs({ now: () => now, concurrency: 1, ttlMs: 100 });
  const gate = defer(); let token;
  const first = jobs.run(message(), 1, async value => { token = value; await gate.promise; return !value.cancelled; });
  const queued = jobs.run(message({ message_id: 2 }), 1, async () => { throw Error('cancelled task must not execute'); });
  await flush(); jobs.forgetUser(42);
  assert.equal(await queued, 'cancelled'); assert.equal(token.cancelled, true);
  gate.resolve(); assert.equal(await first, 'skipped');
  assert.equal(await jobs.run(message(), 2, async () => true), 'delivered');
  assert.equal(await jobs.run(message({ chat: { id: -200, type: 'group' } }), 2, async () => true), 'delivered');
  now = 101;
  assert.equal(await jobs.run(message(), 2, async () => true), 'delivered');
  jobs.forgetChat(-100);
  assert.equal([...jobs.seen.values()].some(value => value.chatId === '-100'), false);
});

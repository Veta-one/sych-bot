const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseReminderTime, resolveReminderDecision, reminderConfirmation, PendingReminders, isRecallQuestion } = require('../src/utils/reminders');
const now = Date.parse('2026-09-25T05:00:00Z'); // Friday, 10:00 Yekaterinburg.

test('times are computed from the source, including spoken numbers and zones', () => {
  for (const [expression, expected] of [
    ['завтра в 12', '2026-09-26T07:00:00.000Z'],
    ['завтра в двенадцать', '2026-09-26T07:00:00.000Z'],
    ['через час', '2026-09-25T06:00:00.000Z'],
    ['через две минуты', '2026-09-25T05:02:00.000Z'],
    ['через полчаса', '2026-09-25T05:30:00.000Z'],
    ['через час и 30 минут', '2026-09-25T06:30:00.000Z'],
    ['послезавтра в 19:30 МСК', '2026-09-27T16:30:00.000Z'],
    ['26 сентября в 20:00 МСК', '2026-09-26T17:00:00.000Z'],
    ['26.09.2026 в 12:00', '2026-09-26T07:00:00.000Z'],
    ['2026-09-26 в 12:00 UTC+3', '2026-09-26T09:00:00.000Z'],
    ['в понедельник в 14:00', '2026-09-28T09:00:00.000Z'],
    ['завтра в семь вечера', '2026-09-26T14:00:00.000Z'],
  ]) {
    const result = parseReminderTime(expression, { now });
    assert.equal(new Date(result.timestamp).toISOString(), expected, expression);
  }
});

test('missing, invalid and past times are not silently defaulted or rolled forward', () => {
  for (const expression of ['завтра', 'вечером', '31.02.2027 в 12', 'сегодня в 9', 'завтра в 25:00', 'завтра в 12:90', 'каждый день в 12', 'в следующем месяце в 12']) {
    assert.ok(parseReminderTime(expression, { now }).issue, expression);
  }
  for (const expression of ['через -1 час', 'через 1.5 часа', 'через несколько минут', 'через час или два', 'через 0 минут']) {
    assert.ok(parseReminderTime(expression, { now }).issue, expression);
  }
});

const plan = { intent: 'schedule', reminderText: 'Купить молоко', timeSource: 'request', timeQuotes: ['завтра в 12'] };
test('direct recall questions cannot become timers even if the model guesses schedule', () => {
  for (const userText of ['Сыч, а напомни, сколько раз Путин участвовал в дебатах?', 'Сыч напомни, во сколько завтра стрим?', 'Напомни мне, пожалуйста, что мы решили?']) {
    assert.ok(isRecallQuestion(userText));
    assert.equal(resolveReminderDecision(plan, { userText, now }).kind, 'answer');
  }
  assert.equal(isRecallQuestion('Сыч напомни через час спросить, сколько стоит ремонт'), false);
});
test('schedule decisions require literal time evidence and ignore invented ISO/confirmation fields', () => {
  const valid = resolveReminderDecision({ ...plan, targetTime: '2099-01-01', confirmation: 'Завтра в 3' }, { userText: 'Сыч напомни завтра в 12 купить молоко', now });
  assert.equal(valid.kind, 'schedule');
  assert.equal(valid.targetTime, '2026-09-26T07:00:00.000Z');
  assert.match(reminderConfirmation(valid), /26\.09\.2026.*12:00/);
  assert.equal(resolveReminderDecision(plan, { userText: 'Сыч напомни купить молоко', now }).kind, 'clarify');
  assert.equal(resolveReminderDecision({ ...plan, reminderText: 'Сыч' }, { userText: 'Сыч напомни завтра в 12', now }).kind, 'clarify');
  assert.equal(resolveReminderDecision({ intent: 'answer_now' }, { userText: 'Сыч напомни, когда у нас завтра созвон', contextText: 'Завтра в 12:00', now }).kind, 'answer');
});

test('reply events use the announcement date and support offsets without inventing a new date', () => {
  const event = { ...plan, timeSource: 'context', timeQuotes: ['завтра в 20:00 МСК'], offsetQuote: 'за час до начала' };
  const input = { userText: 'Сыч напомни за час до начала', contextText: 'Стрим завтра в 20:00 МСК', contextDate: now, now };
  assert.equal(resolveReminderDecision(event, input).targetTime, '2026-09-26T16:00:00.000Z');
  assert.equal(resolveReminderDecision(event, { ...input, contextDate: now - 7 * 86400000 }).kind, 'clarify');
  assert.equal(resolveReminderDecision(event, { ...input, contextText: 'Стрим завтра в 20:00 МСК, созвон в 21:00' }).kind, 'clarify');
  assert.equal(resolveReminderDecision({ ...event, offsetQuote: 'за два часа до начала' }, input).kind, 'clarify');
  assert.equal(parseReminderTime('через час', { now, referenceDate: now - 2 * 3600000 }).issue, 'past');
  assert.equal(resolveReminderDecision({ ...event, timeQuotes: ['20:00 МСК'] }, input).kind, 'clarify');
  assert.equal(resolveReminderDecision({ ...event, timeQuotes: ['завтра в 20:00'] }, input).kind, 'clarify');
});

test('follow-up can supply only the missing clock while retaining the original date', () => {
  const decision = resolveReminderDecision({ ...plan, timeQuotes: ['завтра', 'в 12'] }, {
    userText: 'Сыч напомни завтра про молоко\nУточнение пользователя: в 12', now,
  });
  assert.equal(decision.targetTime, '2026-09-26T07:00:00.000Z');
});

test('pending clarification is scoped to sender, chat, topic, business connection and exact reply', () => {
  let clock = now;
  const pending = new PendingReminders({ now: () => clock, ttlMs: 1000 });
  const msg = { chat: { id: -100 }, from: { id: 42 }, reply_to_message: { message_id: 88 } };
  pending.set(msg, 184, 88, { userText: 'напомни завтра', contextText: 'Анонс' });
  assert.equal(pending.get(msg, 184).contextText, 'Анонс');
  for (const other of [{ ...msg, from: { id: 43 } }, { ...msg, chat: { id: -101 } }, { ...msg, business_connection_id: 'other' }, { ...msg, reply_to_message: { message_id: 89 } }]) {
    assert.equal(pending.get(other, 184), null);
  }
  assert.equal(pending.get(msg, 185), null);
  clock += 1001;
  assert.equal(pending.get(msg, 184), null);
  pending.set(msg, 184, 88, { userText: 'напомни' });
  pending.forgetUser(42);
  assert.equal(pending.get(msg, 184), null);
});

test('reminder delivery preserves topic and reply and retries failed sends without losing data', async () => {
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/reminder-delivery.js'), 'utf8'), {
    module: box, require: () => ({ escapeHtml: s => s }), console: { log() {}, error() {} },
  });
  let tasks = [{ id: 1, chatId: -100, threadId: 184, businessId: 'b', sourceMessageId: 12, text: 'Анонс' }];
  const sent = [];
  let fail = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  const deliver = box.exports.createReminderDelivery({}, {
    getPendingReminders: () => tasks,
    removeReminders: ids => { tasks = tasks.filter(t => !ids.includes(t.id)); }, forceSave() {},
  }, async (...args) => { sent.push(args); if (fail) throw new Error('timeout'); await gate; });
  await deliver();
  assert.equal(tasks.length, 1);
  fail = false;
  const active = deliver();
  await deliver();
  release();
  await active;
  assert.equal(sent.length, 2, 'no concurrent duplicate');
  assert.equal(sent[1][3].threadId, 184);
  assert.equal(sent[1][3].businessId, 'b');
  assert.equal(sent[1][3].replyTo, 12);
  assert.equal(tasks.length, 0);
});

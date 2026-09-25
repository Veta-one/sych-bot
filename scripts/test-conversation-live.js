// Explicit opt-in integration checks. Never starts polling or opens production data.
// node scripts/test-conversation-live.js             -> real reminder classifier
// node scripts/test-conversation-live.js --telegram  -> real handlers + admin Telegram
// Voice fixtures: test-output/{math,recall,plain,reply,reminder}.ogg
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const runDir = path.resolve('test-output', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
process.env.SYCH_DATA_DIR = path.join(runDir, 'data');
const config = require('../src/config');
const storage = require('../src/services/storage');
const ai = require('../src/services/ai');
const report = { version: config.version, started: new Date().toISOString(), mode: process.argv.includes('--telegram') ? 'telegram-handler' : 'classifier', cases: [] };

async function check(name, input, callback) {
  const row = { name, input };
  try { Object.assign(row, await callback()); row.pass = true; }
  catch (error) { row.pass = false; row.error = error.message; }
  report.cases.push(row);
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${name}${row.error ? ': ' + row.error : ''}`);
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  return row;
}

async function classifier() {
  let raw;
  const runLogic = ai.runLogicModel.bind(ai);
  ai.runLogicModel = async (...args) => { raw = await runLogic(...args); return raw; };
  const now = Date.parse('2026-09-25T05:00:00Z');
  const cases = [
    ['recall-politics', 'Сыч, а напомни, сколько раз Путин участвовал в дебатах?', '', 'answer'],
    ['recall-how', 'Сыч напомни, как сварить рис?', '', 'answer'],
    ['recall-event', 'Сыч напомни, когда у нас завтра созвон?', 'Завтра созвон в 12:00', 'answer'],
    ['missing-time', 'Сыч напомни купить молоко', '', 'clarify'],
    ['missing-clock', 'Сыч напомни завтра купить молоко', '', 'clarify'],
    ['missing-subject', 'Сыч напомни завтра в 12', '', 'clarify'],
    ['tomorrow', 'Сыч напомни завтра в 12 купить молоко', '', 'schedule', '2026-09-26T07:00:00.000Z'],
    ['spoken-number', 'Сыч напомни завтра в двенадцать купить молоко', '', 'schedule', '2026-09-26T07:00:00.000Z'],
    ['duration', 'Сыч напомни через час и 30 минут выпить воды', '', 'schedule', '2026-09-25T06:30:00.000Z'],
    ['future-question', 'Сыч напомни через час спросить, сколько стоит ремонт', '', 'schedule', '2026-09-25T06:00:00.000Z'],
    ['reply-announcement', 'Сыч напомни завтра в 12', 'В субботу состоится стрим про игры', 'schedule', '2026-09-26T07:00:00.000Z'],
    ['event-time', 'Сыч напомни об этом', 'Стрим завтра в 20:00 МСК', 'schedule', '2026-09-26T17:00:00.000Z'],
    ['event-offset', 'Сыч напомни за час до начала', 'Стрим завтра в 20:00 МСК', 'schedule', '2026-09-26T16:00:00.000Z'],
    ['multiple-events', 'Сыч напомни об этом', 'Завтра стрим в 12:00, а концерт в 18:00', 'clarify'],
    ['past', 'Сыч напомни сегодня в 9 купить молоко', '', 'clarify'],
    ['recurring', 'Сыч напоминай каждый день в 12 пить воду', '', 'clarify'],
    ['follow-up', 'Сыч напомни завтра купить молоко\nУточнение пользователя: в 12', '', 'schedule', '2026-09-26T07:00:00.000Z'],
    ['cancel', 'Сыч напомни купить молоко\nУточнение пользователя: отмена', '', 'cancel'],
  ];
  for (const [name, text, contextText, kind, targetTime] of cases) {
    const filter = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
    if (filter && !filter.split(',').includes(name)) continue;
    await check(name, { text, contextText, now: new Date(now).toISOString() }, async () => {
      raw = undefined;
      const result = await ai.parseReminder(text, contextText, { now, contextDate: now });
      // Save failed results, too, so the report describes the actual failure.
      fs.writeFileSync(path.join(runDir, `${name}.json`), JSON.stringify({ result, raw }, null, 2));
      assert.equal(result.kind, kind, JSON.stringify({ result, raw }));
      if (targetTime) assert.equal(result.targetTime, targetTime);
      if (kind === 'schedule') {
        const subject = /reply-announcement|event-/.test(name) ? /стрим/i : name === 'duration' ? /вод/i : name === 'future-question' ? /ремонт/i : /молок/i;
        assert.match(result.reminderText, subject);
      }
      return { result, raw };
    });
  }
}

async function telegram() {
  const { TelegramBot } = require('node-telegram-bot-api');
  const bot = new TelegramBot(config.telegramToken, { polling: false });
  const me = await bot.getMe();
  assert.equal(me.id, config.botId);
  const admin = config.adminId;
  assert.ok(Number.isSafeInteger(admin) && admin > 0);
  report.bot = me.username;
  report.method = 'Inputs injected into processMessage as synthetic admin updates. Audio uploaded/downloaded through Telegram; real AI and actual outgoing Telegram messages. No user session or production polling used; storage isolated.';
  const rich = require('../src/utils/rich');
  const originalSend = rich.sendRich;
  const sends = [], parses = [], transcripts = [], responses = [], rawDecisions = [];
  rich.sendRich = async (instance, chatId, content, opts = {}) => {
    assert.equal(chatId, admin, 'Live test may only send to configured admin');
    const result = await originalSend(instance, chatId, content, opts);
    sends.push({ content, opts, ...result });
    return result;
  };
  for (const [method, collection] of [['runLogicModel', rawDecisions], ['parseReminder', parses], ['transcribeAudio', transcripts], ['getResponse', responses]]) {
    const original = ai[method].bind(ai);
    ai[method] = async (...args) => { const result = await original(...args); collection.push(result); return result; };
  }
  const { processMessage } = require('../src/core/logic');
  const { createReminderDelivery } = require('../src/services/reminder-delivery');
  storage.updateChatProfile(admin, { topic: 'Изолированная проверка функций бота' });
  await bot.sendMessage(admin, '🧪 Проверка новой версии Сыча. Ниже — тестовые запросы и реальные ответы. Входящие события подаются тестовым скриптом; модели и отправка Telegram настоящие. Тестовые напоминания хранятся отдельно от рабочих.');
  const reply = row => ({ message_id: row.outputs.at(-1).messageId, from: me, text: row.outputs.at(-1).content.markdown || '' });
  async function context(text) {
    const msg = await bot.sendMessage(admin, `🧪 Тестовый анонс\n${text}`);
    return { ...msg, text, from: { id: admin, first_name: 'Тест' } };
  }
  async function request(name, { text, audio, spoken, replyTo }, expect) {
    const filter = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
    if (filter && !filter.split(',').includes(name)) return { pass: false, skipped: true };
    const before = { sent: sends.length, parsed: parses.length, transcribed: transcripts.length, answered: responses.length, tasks: storage.data.reminders.length, raw: rawDecisions.length };
    return check(name, { text: text || spoken, audio, replyTo: replyTo?.text }, async () => {
      let incoming;
      if (audio) {
        await bot.sendMessage(admin, `🧪 ${name} · синтезированное голосовое: «${spoken}»`);
        incoming = await bot.sendVoice(admin, fs.readFileSync(path.resolve('test-output', `${audio}.ogg`)), {}, { filename: `${audio}.ogg`, contentType: 'audio/ogg' });
      } else {
        incoming = await bot.sendMessage(admin, `🧪 ${name}\n${text}`);
        incoming.text = text;
      }
      incoming.from = { id: admin, first_name: 'Тестировщик', is_bot: false };
      if (replyTo) incoming.reply_to_message = replyTo;
      await processMessage(bot, incoming);
      const result = { outputs: sends.slice(before.sent), decisions: parses.slice(before.parsed), transcripts: transcripts.slice(before.transcribed), answers: responses.slice(before.answered), created: storage.data.reminders.slice(before.tasks), raw: rawDecisions.slice(before.raw), contextDate: replyTo?.date };
      fs.writeFileSync(path.join(runDir, `${name}.json`), JSON.stringify(result, null, 2));
      assert.ok(result.outputs.length > 0, 'No Telegram output');
      assert.ok(result.outputs.every(s => s.ok && s.messageId), 'Telegram did not return message ids');
      if (expect.kind) assert.equal(result.decisions.at(-1)?.kind, expect.kind, JSON.stringify(result.decisions));
      assert.equal(result.created.length, expect.created || 0);
      if (expect.subject) assert.match(result.created[0]?.text || '', expect.subject);
      if (expect.answer) {
        assert.equal(result.answers.length, 1);
        assert.equal(result.outputs.length, 1, 'No transcript card alongside a dialog answer');
        assert.match(result.answers[0], expect.answer);
      }
      if (expect.card) { assert.match(result.outputs[0].content.html, /🎙/); assert.equal(result.answers.length, 0); }
      return result;
    });
  }
  await request('text-recall', { text: 'Сыч, напомни, сколько дней в неделе?' }, { kind: 'answer', answer: /7|семь/i });
  const missing = await request('missing-time', { text: 'Сыч, напомни купить молоко' }, { kind: 'clarify' });
  if (missing.pass) await request('time-follow-up', { text: 'завтра в 12', replyTo: reply(missing) }, { kind: 'schedule', created: 1, subject: /молок/i });
  const announce = await context('В субботу состоится стрим про игры.');
  await request('reply-announcement', { text: 'Сыч напомни завтра в 12', replyTo: announce }, { kind: 'schedule', created: 1, subject: /стрим.*игр/i });
  const timed = await context('Стрим завтра в 20:00 МСК.');
  await request('event-offset', { text: 'Сыч напомни за час до начала', replyTo: timed }, { kind: 'schedule', created: 1, subject: /стрим/i });
  await request('recall-event', { text: 'Сыч напомни, во сколько завтра стрим?', replyTo: timed }, { kind: 'answer', answer: /20:00|20\.00|восемь|в 20/ });
  const cancel = await request('missing-clock', { text: 'Сыч напомни завтра проверить заметки' }, { kind: 'clarify' });
  if (cancel.pass) await request('cancel-follow-up', { text: 'отмена', replyTo: reply(cancel) }, { kind: 'cancel' });
  const math = await request('voice-math', { audio: 'math', spoken: 'Сыч, сколько будет два плюс два?' }, { answer: /4|четыре/i });
  if (math.pass) await request('voice-reply', { audio: 'reply', spoken: 'А сколько будет три плюс пять?', replyTo: reply(math) }, { answer: /8|восемь/i });
  await request('voice-recall', { audio: 'recall', spoken: 'Сыч, напомни, сколько дней в неделе?' }, { kind: 'answer', answer: /7|семь/i });
  await request('voice-plain', { audio: 'plain', spoken: 'Мы завтра собираемся прогуляться по парку. Если будет дождь, останемся дома.' }, { card: true });
  const reminder = await request('voice-reminder', { audio: 'reminder', spoken: 'Сыч, напомни через минуту проверить тестовое уведомление.' }, { kind: 'schedule', created: 1, subject: /уведомлен/i });
  if (reminder.pass) {
    const task = reminder.created[0];
    const remaining = Math.max(0, Date.parse(task.time) - Date.now() + 250);
    console.log(`Waiting ${Math.ceil(remaining / 1000)}s for the real reminder deadline`);
    await new Promise(resolve => setTimeout(resolve, remaining));
    await check('actual-reminder-delivery', { text: task.text, scheduledTime: task.time }, async () => {
      const start = sends.length;
      await createReminderDelivery(bot, storage)();
      const outputs = sends.slice(start);
      assert.equal(outputs.length, 1);
      assert.ok(outputs[0].messageId);
      assert.equal(outputs[0].opts.replyTo, task.sourceMessageId);
      assert.ok(!storage.data.reminders.some(r => r.id === task.id));
      return { outputs, deliveredAt: new Date().toISOString() };
    });
  }
}

(async () => {
  try { await (report.mode === 'classifier' ? classifier() : telegram()); }
  catch (error) { report.fatal = error.message; console.error(error.message); }
  report.finished = new Date().toISOString();
  report.passed = report.cases.filter(row => row.pass).length;
  report.failed = report.cases.filter(row => !row.pass).length;
  storage.forceSave();
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const markdown = `# Проверка Сыча\n\n${report.mode} · ${report.started}\n\n${report.method || 'Настоящая модель классификации, фиксированное время для сверки дат.'}\n\n`
    + report.cases.map(row => `## ${row.pass ? 'PASS' : 'FAIL'} ${row.name}\n\nЗапрос: ${JSON.stringify(row.input)}\n\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\`\n`).join('\n');
  fs.writeFileSync(path.join(runDir, 'report.md'), markdown);
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, fatal: report.fatal, report: path.join(runDir, 'report.md') }));
  process.exit(report.failed || report.fatal ? 1 : 0);
})();

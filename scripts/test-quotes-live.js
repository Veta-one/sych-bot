// Explicit integration check: sends synthetic formatting cards only to the admin.
// No polling, real chat history, AI requests or production storage writes.
const assert = require('node:assert/strict');
const axios = require('axios');
const config = require('../src/config');
const { sendRich, formatVoiceMessage } = require('../src/utils/rich');
axios.defaults.timeout = 20000;

async function main() {
  assert.ok(process.argv.includes('--telegram'), 'Use --telegram to send test cards to the configured admin');
  assert.ok(config.adminId && config.telegramToken);
  const bot = { sendMessage: async (chatId, text, options) => {
    const response = await axios.post(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`,
      { chat_id: chatId, text, ...options }, { proxy: false });
    return response.data.result;
  } };
  const long = 'Тестовая расшифровка: обсуждаем расходы на подписки и переход на другой сервис. '
    .repeat(15);
  const cases = [
    ['short', formatVoiceMessage({ text: 'Тест: завтра встречаемся в двенадцать. Возьми с собой ноутбук.' }, 'Проверка короткого войса', 12)],
    ['long-summary', formatVoiceMessage({ text: long, summary: 'Обсуждаем расходы на подписки и переход на другой сервис.' }, 'Проверка длинного войса', 179)],
    ['long-no-summary', formatVoiceMessage({ text: long }, 'Проверка без саммари', 179)],
    ['markdown', { markdown: '**Проверка цитат**\n\n> Цитата должна быть свёрнута по умолчанию.\n> Вторая строка.\n> Третья строка.\n> Четвёртая строка.\n> Пятая строка.\n\n<details><summary>Один клик</summary>\n\n<blockquote>Внутри раскрытия цитата сразу открыта.</blockquote>\n</details>' }],
  ];
  for (const [name, card] of cases) {
    const result = await sendRich(bot, config.adminId, card, { silent: true });
    console.log(JSON.stringify({ name, ...result }));
    assert.equal(result.mode, 'rich', `${name}: native rich formatting rejected`);
    assert.ok(result.messageId);
  }
}
main().catch(error => { console.error(error.response?.data?.description || error.message); process.exitCode = 1; });

const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldSkipSearchForPrimarySource } = require('../src/utils/content-policy');

test('document and transcript questions do not trigger unrelated web search', () => {
  assert.equal(shouldSkipSearchForPrimarySource('Сыч, кто выполнил план и на сколько процентов?', true), true);
  assert.equal(shouldSkipSearchForPrimarySource('Сыч, перескажи этот ролик', true), true);
  assert.equal(shouldSkipSearchForPrimarySource('Разбери презентацию и выдели риски', true), true);
  assert.equal(shouldSkipSearchForPrimarySource('Проверь арифметику в таблице', true), true);
  assert.equal(shouldSkipSearchForPrimarySource('Проверь код на ошибки', true), true);
});

test('fact-checking a supplied article does not require the words internet or today', () => {
  for (const text of ['Сыч проверь правдивость разбора', 'Это правда?', 'Ты уверен?', 'Найди первоисточник', 'Сыч нагугли ссылку']) {
    assert.equal(shouldSkipSearchForPrimarySource(text, true), false, text);
  }
});

test('explicit comparison with current external data may use web search', () => {
  assert.equal(shouldSkipSearchForPrimarySource('Сравни показатели таблицы с актуальным рынком', true), false);
  assert.equal(shouldSkipSearchForPrimarySource('Проверь эти утверждения в интернете', true), false);
  assert.equal(shouldSkipSearchForPrimarySource('Любой вопрос без приложенного источника', false), false);
});

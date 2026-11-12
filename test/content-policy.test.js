const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldSkipSearchForPrimarySource, searchRequestIntent, requiresResearch, sourceReadIntent } = require('../src/utils/content-policy');

test('source-reading fallback follows the current action rather than link availability or short length', () => {
  for (const text of ['Сыч, https://example.org/post', 'Прочитай исходную статью', 'Перескажи видео', 'Проверь правдивость поста']) {
    assert.equal(sourceReadIntent(text, true), true, text);
    assert.equal(sourceReadIntent(text, false), false, text);
  }
  for (const text of ['Расскажи анекдот по сюжету', 'И как отводить тепло?', 'буквами отвечай',
    'Проверь орфографию в тексте', 'Шутку по сюжету https://example.org/post',
    'Не открывай ссылки, объясни по тексту', 'Не надо читать сайт, придумай по этому сюжету диалог']) {
    assert.equal(sourceReadIntent(text, true), false, text);
  }
});

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

test('explicit web and named-platform requests remain actionable without a planner', () => {
  for (const [text, domains] of [
    ['Сыч, найди Поки на гите под php2shell', ['github.com']],
    ['Найди реализацию на GitHub', ['github.com']],
    ['Подбери рекомендации на Reddit', ['reddit.com']],
    ['найди самую лучшую программу по версии редита на сегодня', ['reddit.com']],
    ['Найди программу по мнению Reddit', ['reddit.com']],
    ['Подбери программу по обсуждениям reddit.com', ['reddit.com']],
    ['Найди обсуждение на реддите', ['reddit.com']],
    ['Найди документацию на сайте example.org', ['example.org']],
    ['Найди на www.example.org документацию', ['example.org']],
    ['Найди ответ на сайте проекта', []],
    ['Найди примеры в интернете', []],
    ['Search the web for php2shell', []],
    ['site:github.com php2shell', ['github.com']],
    ['Найди проект на github.com.evil.example', ['github.com.evil.example']],
  ]) assert.deepEqual(searchRequestIntent(text), {
    explicitSearch: true, output: 'answer', requiredDomains: domains, requiredTimeRange: null,
  }, text);
  assert.equal(shouldSkipSearchForPrimarySource('Сыч, найди Поки на гите под php2shell', true), false);
});

test('sources output requires a result-list request and analysis wins in compound requests', () => {
  for (const text of ['Сыч найди ссылки на GitHub', 'Найди на Reddit только список',
    'Дай ссылки на GitHub', 'Пришли ссылки на Reddit',
    'Нагугли источники', 'Find links on GitHub']) {
    assert.equal(searchRequestIntent(text).output, 'sources', text);
  }
  for (const text of ['Найди ссылки на GitHub и выбери подходящий проект',
    'Найди ссылки на Reddit и сравни варианты', 'Найди источники и объясни вывод',
    'Find links on GitHub and explain the differences']) {
    assert.equal(searchRequestIntent(text).output, 'answer', text);
  }
});

test('local find tasks and incidental product names do not become forced web searches', () => {
  for (const text of ['Найди ошибку в этом коде', 'Поищи файл в локальной папке',
    'Найди ссылки в этом сообщении', 'Найди источники в приложенном тексте',
    'Найди упоминание github.com в этом файле', 'Найди альтернативы GitHub',
    'Найди Reddit в этом сообщении', 'Дай ссылки из этого сообщения', 'Пришли ссылки из этого сообщения',
    'Дай свой ответ', 'Привет', 'Я пользуюсь GitHub', null, {}]) {
    assert.deepEqual(searchRequestIntent(text), {
      explicitSearch: false, output: null, requiredDomains: [], requiredTimeRange: null,
    }, String(text));
  }
  assert.equal(searchRequestIntent('Найди в интернете объяснение ошибки в этом коде').explicitSearch, true);
  assert.equal(shouldSkipSearchForPrimarySource('Поищи ссылку в этом тексте', true), true);
});

test('a requested platform and explicit publication window survive recommendation wording', () => {
  for (const [period, range] of [['за сегодня', 'day'], ['за последние 24 часа', 'day'],
    ['за последнюю неделю', 'week'], ['за последние 7 дней', 'week'],
    ['за последний месяц', 'month'], ['за последние 30 дней', 'month'],
    ['за последний год', 'year'], ['за последние 365 дней', 'year']]) {
    assert.deepEqual(searchRequestIntent(`Подбери рекомендации на Reddit ${period}`), {
      explicitSearch: true, output: 'answer', requiredDomains: ['reddit.com'], requiredTimeRange: range,
    }, period);
  }
  for (const qualifier of ['на сегодня', 'сейчас', 'актуальные', 'за последние 3 недели']) {
    assert.equal(searchRequestIntent(`Найди на Reddit рекомендации ${qualifier}`).requiredTimeRange, null, qualifier);
  }
});

test('verification behavior stays available while incidental platform mentions are not required sources', () => {
  for (const text of ['Проверь правдивость этого поста', 'Это правда?', 'Ты уверен?', 'Найди первоисточник']) {
    assert.equal(searchRequestIntent(text).explicitSearch, true, text);
  }
  assert.deepEqual(searchRequestIntent('Проверь, есть ли альтернативы GitHub').requiredDomains, []);
  assert.equal(searchRequestIntent('Проверь орфографию в тексте').explicitSearch, false);
});

test('intent scanning is bounded and never treats an appended oversized payload as the request', () => {
  assert.equal(searchRequestIntent('Обычный вопрос ' + 'x'.repeat(9000) + ' найди в интернете').explicitSearch, false);
});

test('research veto protects fact checks, comparisons, causal and high-stakes requests', () => {
  for (const text of [
    'Сыч, проверь мою теорию про Anthropic',
    'Сыч, перепроверь ответ',
    'Проверь утверждение о зарплате в этом тексте',
    'Это правда?',
    'Сыч, точно?',
    'Fact-check the news story',
    'Сравни модели и выбери лучшую',
    'Сравни данные в таблице с официальным отчётом',
    'Какая из этих моделей лучше для монтажа?',
    'Почему поменялись условия подписки?',
    'Из-за чего вырос курс?',
    'Можно ли принимать ибупрофен вместе с другим лекарством?',
    'Какая формула расчёта дозировки для ребёнка?',
    'Легально ли это в Казахстане?',
    'Стоит ли покупать акции компании?',
    'Безопасно ли подключать это устройство?',
  ]) assert.equal(requiresResearch(text), true, text);
});

test('research veto does not cover plain lookup, links, chat, or local work', () => {
  for (const text of [
    'Сыч, найди последнюю версию Node.js',
    'Проверь курс доллара на сегодня',
    'Посмотри погоду в Екатеринбурге завтра',
    'Look up the match score',
    'Найди первоисточник',
    'Что ты об этом думаешь?',
    'Привет',
    'Перепроверь вычисления',
    'Проверь вычисление факториала',
    'Проверь этот расчёт',
    'Проверь орфографию в тексте',
    'Сравни эти два числа',
    'Почему в этом коде ошибка?',
    'Запрос ' + 'x'.repeat(9000) + ' фактчек',
    null,
  ]) assert.equal(requiresResearch(text), false, String(text).slice(0, 100));
});

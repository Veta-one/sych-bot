// === ДЕМО / СМОУК-ТЕСТ RICH MESSAGES ===
// Шлёт АДМИНУ в личку набор примеров новых "богатых" сообщений + живые ответы нейронки.
// Только отправка (без polling) — НЕ конфликтует с прод-ботом на сервере.
//
// Запуск из корня проекта:  node scripts/rich-demo.js
// Нужен .env с TELEGRAM_BOT_TOKEN, ADMIN_USER_ID и хотя бы одним AI-ключом.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const TelegramBot = require('node-telegram-bot-api');
const config = require('../src/config');
const ai = require('../src/services/ai');
const { sendRich } = require('../src/utils/rich');

const bot = new TelegramBot(config.telegramToken, { polling: false });
ai.setBot(bot);
const ADMIN = config.adminId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(label, content, opts) {
  try {
    const res = await sendRich(bot, ADMIN, content, opts);
    console.log(`[DEMO] ${label.padEnd(18)} -> ${res.mode}${res.error ? '  («' + res.error + '»)' : ''}`);
  } catch (e) {
    console.error(`[DEMO] ${label.padEnd(18)} -> FAILED: ${e.response?.data?.description || e.message}`);
  }
  await sleep(1000);
}

async function ask(label, question, instruction = '') {
  try {
    const text = await ai.getResponse(
      [], { sender: 'Виталий', text: question, replyText: '' },
      null, 'image/jpeg', instruction, null, false, null
    );
    console.log(`[DEMO] AI "${question.slice(0, 30)}..." -> ${text ? text.length + ' симв.' : 'ПУСТО'}`);
    await send(label, { markdown: text || '_(нейронка вернула пустоту)_' });
  } catch (e) {
    console.error(`[DEMO] AI "${question.slice(0, 30)}" FAILED: ${e.message}`);
    await send(label, { markdown: `⚠️ Не смог получить ответ ИИ: \`${e.message}\`` });
  }
}

async function main() {
  if (!ADMIN) { console.error('[DEMO] Нет ADMIN_USER_ID в .env'); process.exit(1); }
  console.log(`[DEMO] Шлю примеры админу ${ADMIN}...\n`);

  // 0) Проба пера (markdown-поле)
  await send('intro', { markdown: '🦉 *Сыч обновился!* Теперь умею document-grade форматирование. Лови примеры новых сообщений ⬇️' });

  // 1) СТАТИСТИКА — как будет выглядеть «Сыч стата» (HTML: заголовок + таблица + details)
  await send('stats', { html:
`<h3>📊 Статистика Сыча</h3>
<p>Сегодня <b>13.06</b> · режим <b>⚡️ API</b></p>
<table>
<tr><th>Канал</th><th>Запросов</th></tr>
<tr><td>Smart (ответы)</td><td>128</td></tr>
<tr><td>Logic (анализ)</td><td>540</td></tr>
<tr><td>Search (поиск)</td><td>17</td></tr>
</table>
<details><summary>Подробнее по периодам</summary>
<p>Неделя: API 1 240 · Google 88 · Поиск 96<br/>Месяц: API 5 600 · Google 410 · Поиск 380<br/>Всего: 42.1K запросов</p>
</details>` });

  // 2) ХЕЛП — как будет выглядеть /help (заголовки + списки + сворачивание)
  await send('help', { html:
`<h3>🦉 Что я умею</h3>
<b>Вижу и слышу</b>
<ul>
<li>Кидай войс — расшифрую и сделаю краткую суть</li>
<li>Кидай фото / видео / PDF — пойму и прокомментирую</li>
<li>Гуглю актуальное: курсы, погода, новости</li>
</ul>
<details><summary>🎲 Развлекуха и 🕵️ Досье</summary>
<ul>
<li>«Сыч кинь монетку» — орёл/решка</li>
<li>«Сыч кто я?» — досье на тебя</li>
<li>«Сыч стата» — расход токенов</li>
</ul>
</details>` });

  // 3) РАСШИФРОВКА ВОЙСА — суть + полный текст под катом
  await send('voice', { html:
`<p>🎙 <b>Краткая суть:</b> Виталий спрашивает, во сколько завтра созвон по проекту.</p>
<details><summary>Полный текст</summary>
<blockquote>Слушай, привет. Напомни, пожалуйста, во сколько у нас там завтра созвон по проекту? Кажется, в два, но я не уверен.</blockquote>
</details>` });

  // 4) АЛЕРТ АДМИНУ — новый контакт
  await send('admin-alert', { html:
`<h4>🔔 Новый контакт</h4>
<p>📂 Чат: <b>VETA ПРОБУЕТ</b><br/>🆔 <code>-1001234567890</code><br/>👤 @someuser (Иван)</p>
<blockquote>Привет, а можно у тебя бота такого же попросить?</blockquote>` });

  // 5) ДОСЬЕ — «кто я»
  await send('dossier', { html:
`<h4>🕵️ Досье: @vetaone</h4>
<p>Репутация: <b>92 / 100</b> — БРАТАН 🤝</p>
<blockquote>Зовут Виталий. Делает ботов и AI-проекты. Ценит чёткость и сарказм. Из Екатеринбурга.</blockquote>` });

  // === ТЕСТЫ СИНТАКСИСА (смотрим, что именно отрисуется) ===

  // 6) Чек-лист: эмодзи-вариант (точно работает)
  await send('checklist-emoji', { html:
`<b>План на день</b>
<ul>
<li>✅ Допилить rich-сообщения</li>
<li>⬜ Прогнать смоук-тест</li>
<li>⬜ Раскатать на прод</li>
</ul>` });

  // 7) Чек-лист: нативные чекбоксы (экспериментально — проверяем поддержку)
  await send('checklist-native', { html:
`<b>Нативные чекбоксы?</b>
<ul>
<li><input type="checkbox" checked> готово</li>
<li><input type="checkbox"> не готово</li>
</ul>` });

  // 8) Таблица с выравниванием/зеброй (проверяем атрибуты)
  await send('table-aligned', { html:
`<table class="striped">
<tr><th>Модель</th><th align="right">Цена/ответ</th></tr>
<tr><td>Gemma 3 27B</td><td align="right">0.006 ₽</td></tr>
<tr><td>Gemini 3 Flash</td><td align="right">0.10 ₽</td></tr>
<tr><td>Perplexity Sonar</td><td align="right">0.43 ₽</td></tr>
</table>` });

  // 9) Спойлеры (два варианта синтаксиса)
  await send('spoiler', { html:
`Спойлер-тег: <tg-spoiler>секрет один</tg-spoiler>
span-вариант: <span class="tg-spoiler">секрет два</span>` });

  // 10) Цитата с автором + код
  await send('quote-code', { html:
`<blockquote>Преждевременная оптимизация — корень всех зол.<cite>Дональд Кнут</cite></blockquote>
<pre><code class="language-js">const sych = "🦉";
console.log("Сыч на связи", sych);</code></pre>` });

  // 11) Разделитель
  await send('divider', { html: `Сверху текст<hr/>Снизу текст после разделителя` });

  // 12) Тот же набор, но через MARKDOWN-поле (проверяем расширенный markdown)
  await send('markdown-field', { markdown:
`# Заголовок markdown

Обычный абзац с **жирным** и _курсивом_.

- пункт раз
- пункт два

| A | B |
|---|---|
| 1 | 2 |

> цитата

\`\`\`js
const x = 1;
\`\`\`` });

  // === ЖИВЫЕ ОТВЕТЫ НЕЙРОНКИ (разные вопросы — разный стиль) ===
  console.log('\n[DEMO] Спрашиваю нейронку (живые ответы)...');
  await send('--- AI ---', { markdown: '🤖 *А теперь — живые ответы нейронки на разные вопросы:*' });

  await ask('ai-casual', 'сыч, здарова! как сам, чё делаешь?');
  await ask('ai-fact', 'сыч, в каком году вышел первый айфон?');
  await ask('ai-table',
    'сыч, объясни по-простому разницу между TCP и UDP и сведи различия в табличку',
    'Сейчас уместно ответить подробно: используй Markdown — короткий заголовок, и обязательно таблицу сравнения.');
  await ask('ai-list',
    'сыч, накидай 5 коротких пунктов, как новичку начать бегать',
    'Ответь нумерованным списком из 5 пунктов в Markdown.');
}

main().then(() => { console.log('\n[DEMO] Готово.'); process.exit(0); })
  .catch((e) => { console.error('[DEMO] Фатал:', e); process.exit(1); });

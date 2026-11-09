const assert = require('node:assert/strict');
const test = require('node:test');
const { splitSourceAppendix } = require('../src/utils/research-sources');

test('weather answer keeps prose and inline citations while extracting its trailing source list', () => {
  const prose = 'Завтра в Екатеринбурге около +4 °C, пригодится зонт. [Прогноз](https://weather.example.org/tomorrow)';
  const answer = `${prose}\n\n**Источники:**\n1. [Прогноз на завтра](https://weather.example.org/tomorrow)\n2. [Осадки](https://rain.example.org/forecast)`;
  assert.deepEqual(splitSourceAppendix(answer), {
    text: prose,
    links: [
      { url: 'https://weather.example.org/tomorrow', title: 'Прогноз на завтра' },
      { url: 'https://rain.example.org/forecast', title: 'Осадки' },
    ],
  });
});

test('Markdown heading, plain and bold source headings support lists or standalone links', () => {
  for (const heading of ['## Источники', '### **Источники:**', 'Источники:', '**Источники**', '__Источники:__', 'Источники\n----------']) {
    const input = `Проверенный ответ.\n\n${heading}\n\n- [Первый](https://example.org/first)\n- **[Второй](https://example.org/second)**`;
    assert.deepEqual(splitSourceAppendix(input), { text: 'Проверенный ответ.', links: [
      { url: 'https://example.org/first', title: 'Первый' },
      { url: 'https://example.org/second', title: 'Второй' },
    ] });
  }
  assert.deepEqual(splitSourceAppendix('Источники\nhttps://example.org/one\n<https://example.org/two>'), {
    text: '', links: [
      { url: 'https://example.org/one', title: 'https://example.org/one' },
      { url: 'https://example.org/two', title: 'https://example.org/two' },
    ],
  });
});

test('native details with Markdown links are extracted and duplicate URLs retain the first title', () => {
  const input = 'Ответ.\n\n<details><summary>Источники</summary>\n\n1. [Первый](https://example.org/a#fragment)\n2. [Дубль](https://example.org/a)\n3. [Другой](https://other.example.org/)\n\n</details>';
  assert.deepEqual(splitSourceAppendix(input), { text: 'Ответ.', links: [
    { url: 'https://example.org/a', title: 'Первый' },
    { url: 'https://other.example.org/', title: 'Другой' },
  ] });
});

test('safe HTML details produce only plain metadata, not trusted HTML', () => {
  const input = 'Ответ.\n\n<details open><summary>Источники</summary><ol><li><a href="https://example.org/?a=1&amp;b=2"><strong>Page</strong> &lt;b&gt;literal&lt;/b&gt;</a></li></ol></details>';
  assert.deepEqual(splitSourceAppendix(input), { text: 'Ответ.', links: [
    { url: 'https://example.org/?a=1&b=2', title: 'Page <b>literal</b>' },
  ] });
});

test('adjacent Markdown and native source appendices collapse without losing distinct links', () => {
  const input = 'Ответ.\n\n**Источники:**\n- [Первый](https://example.org/a)\n\n<details><summary>Источники</summary>\n\n1. [Повтор](https://example.org/a)\n2. [Другой](https://example.org/b)\n\n</details>';
  assert.deepEqual(splitSourceAppendix(input), { text: 'Ответ.', links: [
    { url: 'https://example.org/a', title: 'Первый' },
    { url: 'https://example.org/b', title: 'Другой' },
  ] });
});

test('source prose, coverage notes, captions and nontrailing lists remain unchanged', () => {
  const link = '[Страница](https://example.org/page)';
  for (const input of [
    `Ответ по ${link}.`,
    `Ответ.\n\n## Источники\n${link}\n\nНе удалось прочитать все исходные ссылки: ${link}. Это не подтверждает отсутствие страниц.`,
    `Ответ.\n\nИсточники\n- ${link}: прогноз опубликован сегодня.`,
    `Ответ.\n\nИсточники\nПодтверждают только часть вывода.\n${link}`,
    `Ответ.\n\n<details><summary>Источники</summary><p>Страница не открылась.</p><a href="https://example.org/page">Страница</a></details>`,
    `Источники\n${link}\n\n## Вывод\nОстаётся неопределённость.`,
  ]) assert.deepEqual(splitSourceAppendix(input), { text: input, links: [] });
});

test('coverage before the appendix survives verbatim with retained inline citations', () => {
  const prefix = 'Ответ по [странице](https://example.org/page).\n\nНе удалось прочитать вторую исходную ссылку.';
  assert.deepEqual(splitSourceAppendix(`${prefix}\n\nИсточники\n[Страница](https://example.org/page)`), {
    text: prefix, links: [{ url: 'https://example.org/page', title: 'Страница' }],
  });
});

test('fenced, indented and quoted examples never become source appendices', () => {
  for (const input of [
    'Пример:\n\n```markdown\n## Источники\n[Example](https://example.org/)\n```',
    '~~~html\n<details><summary>Источники</summary><a href="https://example.org/">Example</a></details>\n~~~',
    '    Источники\n    [Example](https://example.org/)',
    '> Источники\n> [Example](https://example.org/)',
    'Источники\n`[Example](https://example.org/)`',
  ]) assert.deepEqual(splitSourceAppendix(input), { text: input, links: [] });
  const code = '```markdown\nИсточники\n[Code](https://example.org/code)\n```';
  assert.deepEqual(splitSourceAppendix(`${code}\n\nИсточники\n[Real](https://example.org/real)`), {
    text: code, links: [{ url: 'https://example.org/real', title: 'Real' }],
  });
});

test('unsafe destinations and active HTML are never promoted into collected sources', () => {
  for (const body of [
    '<a href="javascript:alert(1)">Click</a>',
    '<a href="https://example.org/" onclick="alert(1)">Click</a>',
    '<a href="https://example.org/"><img src="https://example.org/x" /></a>',
    '<script>instruction()</script><a href="https://example.org/">Page</a>',
    '<div><a href="https://example.org/">Page</a></div>',
    '<a href="https://example.org/">Missing closing tag',
    '[Local](http://127.0.0.1/)',
    '[Credentials](https://user:password@example.org/)',
  ]) {
    const input = `Ответ.\n\n<details><summary>Источники</summary>${body}</details>`;
    assert.deepEqual(splitSourceAppendix(input), { text: input, links: [] });
  }
  const input = '<details onclick="instruction()"><summary>Источники</summary><a href="https://example.org/">Page</a></details>';
  assert.deepEqual(splitSourceAppendix(input), { text: input, links: [] });
});

test('reference definitions needed by retained citations stay intact', () => {
  const input = 'Ответ со ссылкой [1][page].\n\nИсточники\n[Страница][page]\n\n[page]: https://example.org/page';
  assert.deepEqual(splitSourceAppendix(input), { text: input, links: [] });
});

test('empty headings and unrelated headings preserve input including whitespace', () => {
  for (const input of ['', 'Ответ.\n\nИсточники\n', 'Ответ.\n\nСм. также\n[Page](https://example.org/)\n']) {
    assert.deepEqual(splitSourceAppendix(input), { text: input, links: [] });
  }
});

test('CRLF input preserves body line endings and titles are bounded plain text', () => {
  const prefix = 'Первый абзац.\r\n\r\nВторой абзац.';
  const title = '😀'.repeat(300);
  assert.deepEqual(splitSourceAppendix(`${prefix}\r\n\r\n## Источники\r\n[${title}](https://example.org/page)`), {
    text: prefix, links: [{ url: 'https://example.org/page', title: '😀'.repeat(180) }],
  });
});

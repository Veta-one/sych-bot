const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness(extraDependencies = {}, runtime = {}) {
  const calls = [];
  const notifications = [];
  const config = { geminiKeys: [], searchProvider: 'tavily', mainModel: 'writer', logicModel: 'planner', maxOutputTokens: 1000 };
  const promptsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/prompts.js'), 'utf8'), { module: promptsModule, require: () => config });
  const dependencies = {
    '../utils/private-context': require('../src/utils/private-context'),
    '../utils/profile-evidence': require('../src/utils/profile-evidence'),
    './quick-data': { quickData: async () => '' }, '../utils/research-sources': require('../src/utils/research-sources'),
    '@google/generative-ai': {}, '../config': config, '../core/prompts': promptsModule.exports,
    axios: {}, openai: {}, '@tavily/core': {},
    './storage': { initGoogleStats() {}, resetStatsIfNeeded: () => false, incrementStat() {}, incrementGoogleStat() {} },
    '../utils/rich': { sendRich: async (...args) => { notifications.push(args); } }, './youtube': { isYouTubeUrl: () => false }, './youtube-gemini': {},
    '../utils/content-policy': require('../src/utils/content-policy'), './research': require('../src/services/research'),
    '../utils/async': require('../src/utils/async'), '../utils/voice': {}, '../utils/reminders': {},
  };
  const box = { exports: {} };
  Object.assign(dependencies, extraDependencies);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8'), {
    module: box, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    console: { log() {}, error() {}, warn() {} }, Buffer, setTimeout, clearTimeout, AbortController, ...runtime,
  });
  const ai = box.exports;
  ai.openai = { chat: { completions: { create: async request => { calls.push(request); return { choices: [{ message: { content: 'Ответ Сыча [Источник](https://example.org/countries)' } }] }; } } } };
  ai.runLogicModel = async () => ({ needsSearch: true, searchQuery: 'official countries' });
  ai.performSearch = async () => [{ url: 'https://example.org/countries', title: 'Countries', content: 'Kazakhstan is supported for Claude.ai.' }];
  ai.extractUrl = async () => 'Kazakhstan is supported for Claude.ai.';
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА') ? { approved: true, addressesQuestion: true } : ({ claims: [{ claim: 'Kazakhstan supported.', status: 'supported', sourceId: 'S1', quote: 'Kazakhstan is supported for Claude.ai.', limitation: 'No guarantee for a card.' }], sufficient: true });
  return { ai, calls, config, notifications };
}

test('all links from the replied post are read even if the planner disables search', async () => {
  const { ai, calls } = harness();
  const urls = ['https://example.org/framework', 'https://example.org/model'];
  const reads = [];
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.extractUrl = async url => { reads.push(url); return 'The memory project and model are available.'; };
  ai.performSearch = async () => { throw Error('Direct sources should be sufficient'); };
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА')
    ? { approved: true, addressesQuestion: true }
    : { claims: [{ claim: 'The memory project is available.', status: 'supported', sourceId: 'S1',
      quote: 'The memory project and model are available.' }], sufficient: true, addressesQuestion: true };
  for (const text of ['Сыч глянь все ссылки и дай подробный отчёт', 'Сыч, изучи два документа и сопоставь данные']) {
    reads.length = 0;
    await ai.getResponse([], { sender: 'Тест', text, replyText: `${urls[0]}\n${urls[1]}\n${urls[0]}` });
    assert.deepEqual(reads, urls);
  }
  assert.match(calls[0].messages[1].content[0].text, /memory project is available/);
});

test('a recheck prioritizes the original source context over a wrong previous bot answer', async () => {
  const { ai } = harness();
  let planner;
  const reads = [];
  ai.runLogicModel = async prompt => { planner = prompt; return { needsSearch: false }; };
  ai.extractUrl = async url => { reads.push(url); return 'Original memory framework exists.'; };
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА')
    ? { approved: true, addressesQuestion: true }
    : { claims: [{ claim: 'Memory framework exists.', status: 'supported', sourceId: 'S1',
      quote: 'Original memory framework exists.' }], sufficient: true, addressesQuestion: true };
  await ai.getResponse([], { sender: 'Тест', text: 'Сыч перепроверь все ссылки', replyText: 'Wrong translator claim.',
    sourceContext: { text: 'Original memory announcement.', urls: ['https://example.org/original'] } });
  assert.match(planner, /Original memory announcement/);
  assert.deepEqual(reads, ['https://example.org/original']);
});

test('a linked-source audit cannot approve a draft about the wrong product or omit unread links', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'The project exists.', url: 'https://example.org/project' }], gaps: [], errors: [],
    requestedSources: [{ url: 'https://example.org/project', status: 'read' }, { url: 'https://example.org/missing', status: 'unavailable' }] };
  ai.reviewEvidence = async () => ({ approved: true, addressesQuestion: false });
  const rejected = await ai.finalizeResearchedAnswer('An unrelated translator.', result);
  assert.doesNotMatch(rejected, /unrelated translator/);
  ai.reviewEvidence = async () => ({ approved: true, addressesQuestion: true });
  const accepted = await ai.finalizeResearchedAnswer('The project exists.', result);
  assert.match(accepted, /example.org\/missing/);
  assert.match(accepted, /прочитать/);
});

test('long original posts keep their initial question in research even with eight long hidden URLs', async () => {
  const { buildSourceContext } = require('../src/utils/source-context');
  const { ai } = harness();
  const sourceContext = buildSourceContext({ from: { id: 1 }, text: 'Сыч, объясни локальный запуск с OpenClaw',
    reply_to_message: { from: { id: 2 }, caption: 'Исходный пост. ' + 'Подробности '.repeat(1100),
      caption_entities: Array.from({ length: 8 }, (_, i) => ({ type: 'text_link', url: `https://example.org/${i}/${'a'.repeat(80)}` })) } });
  const prompts = [];
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.extractUrl = async () => 'The project supports a local server.';
  ai.reviewEvidence = async prompt => {
    prompts.push(prompt);
    return prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА') ? { approved: true, addressesQuestion: true }
      : { claims: [{ claim: 'A local server is supported.', status: 'supported', sourceId: 'S1',
        quote: 'The project supports a local server.' }], sufficient: true, addressesQuestion: true };
  };
  await ai.getResponse([], { sender: 'Тест', text: 'Сыч, ты уверен?', sourceContext });
  const evidenceQuestion = JSON.parse(JSON.parse(prompts[0].split('ВОПРОС И КОНТЕКСТ: ')[1].split('\nИСТОЧНИКИ: ')[0]));
  assert.match(evidenceQuestion.reply, /локальный запуск с OpenClaw/);
});

test('a private query supplies both labelled images and the replied text to the main model', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  await ai.getResponse([], { text: 'Сравни изображения', sender: 'Тест', replyText: 'Исходное сообщение' }, [
    { buffer: Buffer.from('first'), mimeType: 'image/png', label: 'Текущий запрос' },
    { buffer: Buffer.from('second'), mimeType: 'image/jpeg', label: 'Исходный реплай' },
  ]);
  const content = calls[0].messages[1].content;
  assert.equal(content.filter(item => item.type === 'image_url').length, 2);
  assert.match(content[0].text, /Сравни изображения/);
  assert.match(content[0].text, /Исходное сообщение/);
  assert.equal(content.filter(item => item.type === 'text').slice(1).map(item => item.text).join('|'), 'Текущий запрос|Исходный реплай');
});

test('native fallback retains both images and their labels for a private query', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.openai.chat.completions.create = async () => { throw new Error('synthetic unavailable'); };
  ai.keys = ['synthetic'];
  let request;
  ai.nativeModel = { generateContent: async value => {
    request = value;
    return { response: { text: () => 'Сравнение', candidates: [{}] } };
  } };
  await ai.getResponse([], { text: 'Сравни', sender: 'Тест' }, [
    { buffer: Buffer.from('a'), mimeType: 'image/png', label: 'A' },
    { buffer: Buffer.from('b'), mimeType: 'image/jpeg', label: 'B' },
  ]);
  const parts = request.contents[0].parts;
  assert.equal(parts.filter(part => part.inlineData).length, 2);
  assert.equal(parts.filter(part => part.inlineData).map(part => part.inlineData.mimeType).join('|'), 'image/png|image/jpeg');
});

test('private model failures do not send admin messages while public notifications still work', async () => {
  const { runPrivateWork } = require('../src/utils/private-context');
  const { ai, config, notifications } = harness();
  ai.bot = {};
  config.adminId = 999;
  await runPrivateWork(async () => ai.notifyAdmin('synthetic private error'));
  assert.equal(notifications.length, 0);
  ai.notifyAdmin('public status');
  assert.equal(notifications.length, 1);
});

test('private YouTube questions neither read nor populate the shared analysis cache', async () => {
  const { runPrivateWork } = require('../src/utils/private-context');
  let cacheReads = 0;
  const requests = [];
  const { ai } = harness({
    './youtube': { isYouTubeUrl: () => true, selectYoutubeTranscriptMaxChars: () => 1000,
      getYoutubeContext: async () => { throw Error('No subtitles'); } },
    './youtube-gemini': { buildYoutubeGeminiPlan: () => ({ cacheKey: 'synthetic-question' }),
      getCachedYoutubeGeminiAnalysis: () => { cacheReads++; return null; },
      requestYoutubeGeminiAnalysis: async (key, plan, options) => { requests.push(options); return { text: 'Video facts' }; },
      buildYoutubeGeminiPromptContext: () => 'Video facts' },
  });
  ai.keys = ['synthetic'];
  ai.executeNativeWithRetry = fn => fn();
  ai.runLogicModel = async () => ({ needsSearch: false });
  const input = { sender: 'Тест', text: 'Сыч перескажи https://www.youtube.com/watch?v=synthetic' };
  await runPrivateWork(() => ai.getResponse([], input));
  assert.equal(cacheReads, 0);
  assert.equal(requests[0].cache, false);
  await ai.getResponse([], input);
  assert.equal(cacheReads, 1);
  assert.equal(requests[1].cache, true);
});

test('search planning receives the replied claim, even outside the short history', async () => {
  const { ai } = harness();
  let prompt;
  ai.runLogicModel = async p => { prompt = p; return { needsSearch: true, searchQuery: 'Claude supported countries' }; };
  await ai.checkSearchNeeded('А кому из СНГ?', 'unrelated conversation', null, 'Anthropic does not support Kazakhstan.');
  assert.match(prompt, /Anthropic does not support Kazakhstan/);
  assert.match(prompt, /А кому из СНГ/);
});

test('explicit verification cannot be skipped by the classifier or by supplied material', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  await ai.getResponse([], { text: 'Сыч, проверь правдивость этого поста', sender: 'Тест' }, null, undefined, '', null, false, null, 'Unverified article claim');
  assert.match(calls[0].messages[1].content[0].text, /РЕЗУЛЬТАТ ПРОВЕРКИ ИСТОЧНИКОВ/);
});

test('planner failure still searches an explicit request and labels other current answers as unverified', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => null;
  const plan = await ai.checkSearchNeeded('Сыч нагугли ссылку', '', null, 'Claim needing verification');
  assert.equal(plan.needsSearch, true);
  assert.match(plan.searchQuery, /Claim needing verification/);
  await ai.getResponse([], { text: 'Какие цены сейчас?', sender: 'Тест' });
  assert.match(calls[0].messages[1].content[0].text, /подтвердить не удалось/);
});

test('an explicit GitHub request survives planner failure while a local code request stays local', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => { throw new Error('planner timeout'); };
  const web = await ai.checkSearchNeeded('Сыч, найди Поки на гите под php2shell', '', null);
  assert.equal(web.needsSearch, true);
  assert.deepEqual([...web.requiredDomains], ['github.com']);
  const local = await ai.checkSearchNeeded('Сыч, найди ошибку в этом коде', '', null);
  assert.equal(local.needsSearch, false);
});

test('a link-only request adds one contextual sentence inside the open list', async () => {
  const { ai, config } = harness();
  const urls = Array.from({ length: 5 }, (_, index) => `https://github.com/demo/fixture-${index}`);
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'sources', searchQuery: 'Тестовые проекты' });
  ai.performSearch = async () => urls.map(url => ({ url, title: 'Fixture', content: 'Search snippet' }));
  ai.reviewEvidence = async () => assert.fail('A list of collected links requires no claims');
  const calls = [];
  ai.openai.chat.completions.create = async (body, options) => {
    calls.push({ body, options });
    return { choices: [{ finish_reason: 'stop', message: { content: 'По теме «ТЕМА» я тут кое-что накопал.' } }] };
  };
  const question = 'Сыч, найди ссылки на GitHub про тестовые проекты';
  const answer = await ai.getResponse([{ role: 'user', text: 'Private history' }], { text: question, sender: 'Private sender' });
  assert.match(answer, /^<details open>[\s\S]*<summary>Источники<\/summary>[\s\S]*По теме «Тестовые проекты» я тут кое-что накопал\.[\s\S]*<\/details>$/);
  for (const url of urls) assert.ok(answer.includes(url));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, config.mainModel);
  assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(JSON.parse(calls[0].body.messages[1].content).question, question);
  assert.equal(JSON.parse(calls[0].body.messages[1].content).topic, 'Тестовые проекты');
  assert.doesNotMatch(JSON.stringify(calls[0].body), /Search snippet|fixture-0|Private history|Private sender/);
});

test('invalid evidence keeps all links visible and preserves strict publication and billing failure', async () => {
  const { ai, calls } = harness();
  const urls = Array.from({ length: 5 }, (_, index) => `https://example.org/result-${index}`);
  ai.performSearch = async () => urls.map(url => ({ url, title: 'Fixture' }));
  ai.reviewEvidence = async () => { throw Object.assign(new Error('Invalid JSON'), { code: 'EVIDENCE_REVIEW_INVALID' }); };
  const request = { text: 'Сыч, сравни варианты', sender: 'Тест' };
  const answer = await ai.getResponse([], request);
  assert.match(answer, /^<details open>[\s\S]*Проверка источников прервалась\./);
  for (const url of urls) assert.ok(answer.includes(url));
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(calls[0].messages[1].content).status, /проверка источников прервалась/);
  await assert.rejects(ai.getResponse([], request, null, undefined, '', null, false, null, '', { failOnUnavailable: true }),
    /PUBLIC_RESPONSE_UNAVAILABLE/);
  assert.equal(calls.length, 1);
});

test('a failed final audit keeps an open source list without forwarding the draft or source bodies', async () => {
  const { ai } = harness();
  const result = {
    claims: [{ claim: 'Private claim', quote: 'Private source body', url: 'https://example.org/page', status: 'supported' }],
    foundSources: [{ title: 'Page', url: 'https://example.org/page', level: 'page' }],
  };
  ai.reviewEvidence = async () => { throw Error('Audit offline'); };
  const calls = [];
  ai.openai.chat.completions.create = async body => {
    calls.push(body);
    return { choices: [{ finish_reason: 'stop', message: { content: 'Проверка споткнулась, вот что я накопал.' } }] };
  };
  const answer = await ai.finalizeResearchedAnswer('Unverified draft', result, {}, 'Сыч, проверь https://example.org/page');
  assert.match(answer, /^<details open>[\s\S]*Проверка споткнулась, вот что я накопал\.[\s\S]*example\.org\/page/);
  assert.doesNotMatch(answer, /Unverified draft|Private claim/);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls[0]), /Unverified draft|Private claim|Private source body|https:\/\/example\.org\/page/);
});

test('an invalid source intro cannot insert markup, links, or multiple sentences', async () => {
  const { ai } = harness();
  const result = { foundSources: [{ title: 'Original', url: 'https://example.org/page' }] };
  for (const content of ['<b>Подделка</b>.', 'Вот подделка https://example.com/evil.', 'Подделка. Вот ещё фраза.']) {
    ai.openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
    const answer = await ai.renderSourceReply(result, 'Сыч, проверь новость', 'evidence');
    assert.match(answer, /^<details open>[\s\S]*Проверка источников прервалась\.[\s\S]*example\.org\/page/);
    assert.doesNotMatch(answer, /подделка|example\.com/i);
  }
});

test('a source intro cannot replace a failed verification with a verdict or promise', async () => {
  const { ai } = harness();
  const result = { foundSources: [{ title: 'Original', url: 'https://example.org/page' }] };
  for (const content of ['Твоя теория верна.', 'Проверка споткнулась, но твоя теория верна.',
    'Проверка зависла, позже перепроверю.', 'Проверка завершена, но страницу открыть не удалось.',
    'Проверка не прервалась, вот ссылки.', 'Проверка не зависла, держи материалы.',
    'Проверка не удалась, но источники подтверждают поддержку PHP 9.',
    'Проверка не удалась и проект гарантированно поддерживает PHP 9.']) {
    ai.openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
    const answer = await ai.renderSourceReply(result, 'Сыч, проверь мою теорию', 'evidence');
    assert.match(answer, /Проверка источников прервалась\./);
    assert.doesNotMatch(answer, /теория верна|перепроверю|Проверка завершена|не прервалась|не зависла|PHP 9/);
  }
  ai.openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop',
    message: { content: 'Я нашёл подтверждение поддержки PHP 9 в этих источниках.' } }] });
  const links = await ai.renderSourceReply(result, 'Сыч, дай ссылки', 'links');
  assert.match(links, /Накопал ссылки\./);
  assert.doesNotMatch(links, /PHP 9/);
});

test('explicit links plus a recommendation keep Reddit and the requested period in the analysis plan', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false, output: 'sources', searchQuery: 'tool recommendations',
    timeRange: 'month', preferredDomains: ['example.org'] });
  const plan = await ai.checkSearchNeeded('Сыч, найди ссылки на Reddit за последнюю неделю и выбери лучшую программу', '', null);
  assert.equal(plan.needsSearch, true);
  assert.equal(plan.output, 'answer');
  assert.deepEqual([...plan.preferredDomains], ['reddit.com']);
  assert.equal(plan.timeRange, 'week');
});

test('a required period never falls back to an unfiltered search', async () => {
  const { ai, config } = harness();
  ai.searchViaNative = async () => assert.fail('This route cannot enforce the requested period');
  const search = Object.getPrototypeOf(ai).performSearch.bind(ai);
  ai.tavilyClient = { search: async (_, opts) => { assert.equal(opts.timeRange, 'week'); return { results: [] }; } };
  assert.equal((await search('tool recommendations', { requiredTimeRange: 'week' })).length, 0);
  ai.tavilyClient.search = async () => { throw new Error('synthetic outage'); };
  await assert.rejects(search('tool recommendations', { requiredTimeRange: 'week' }), /SEARCH_PERIOD_UNAVAILABLE/);
  config.searchProvider = 'perplexity';
  await assert.rejects(search('tool recommendations', { requiredTimeRange: 'week' }), /SEARCH_PERIOD_UNAVAILABLE/);
});

test('a single-value lookup uses one search and one grounded extraction without drafting and auditing', async () => {
  const { ai, calls } = harness();
  const url = 'https://example.org/releases';
  const alternatives = ['https://example.org/other-releases', 'https://example.org/unused'];
  const reads = [];
  let searches = 0;
  let reviews = 0;
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'Node latest release' });
  ai.performSearch = async () => { searches++; return [url, ...alternatives].map(url => ({ url, title: 'Node releases' })); };
  ai.extractUrl = async url => { reads.push(url); return 'The current stable version of my_pkg is 24.7.0.'; };
  ai.reviewEvidence = async prompt => {
    reviews++;
    assert.doesNotMatch(prompt, /ПРОВЕРКА ГОТОВОГО ОТВЕТА/);
    return { claims: [{ claim: 'Стабильная версия my_pkg 24.7.0.', status: 'supported', sourceId: 'S1',
      quote: 'The current stable version of my_pkg is 24.7.0.' }], sufficient: true, addressesQuestion: true };
  };
  const response = await ai.getResponse([], { text: 'Сыч, какая последняя стабильная версия my_pkg?', sender: 'Тест' });
  assert.match(response, /24\.7\.0/);
  assert.ok(response.includes('my\\_pkg'));
  assert.ok(response.includes(url));
  assert.equal(searches, 1);
  assert.deepEqual(reads, [url, alternatives[0]]);
  assert.equal(reviews, 1);
  assert.equal(calls.length, 0);
});

test('an explicit photo request survives a planner refusal and a search with only image results', async () => {
  const { ai, calls } = harness();
  const first = 'https://example.org/one.jpg?a=1&b=2';
  const second = 'https://example.org/two.jpg';
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.performSearch = Object.getPrototypeOf(ai).performSearch.bind(ai);
  const searchOptions = [];
  ai.tavilyClient = { search: async (_, options) => {
    searchOptions.push(options);
    return { results: [], images: [{ url: first, description: 'Фасад дома Бальо' }, { url: second, description: 'Другой ракурс' }] };
  } };
  ai.extractUrl = async () => assert.fail('Image candidates are not text sources');
  ai.reviewEvidence = async prompt => {
    assert.match(prompt, /^ПРОВЕРКА ГОТОВОГО ОТВЕТА/);
    assert.match(prompt, /Фасад дома Бальо/);
    return { approved: true, addressesQuestion: true, imageIds: ['I2', 'I1', 'I2', 'I9', 'https://unknown.org/x'] };
  };
  const answer = await ai.getResponse([], { text: 'Сыч, пришли фотографию дома Бальо', sender: 'Тест' });
  assert.match(answer, /<tg-slideshow><img src="https:\/\/example\.org\/two\.jpg"\/><img src="https:\/\/example\.org\/one\.jpg\?a=1&amp;b=2"\/><\/tg-slideshow>/);
  assert.doesNotMatch(answer, /unknown\.org|Проверку ответа/);
  assert.equal(searchOptions.length, 1);
  assert.equal(searchOptions[0].includeImages, true);
  assert.equal(searchOptions[0].includeImageDescriptions, true);
  assert.equal(calls.length, 0);
});

test('a normal researched answer uses only images chosen by its existing audit', async () => {
  const { ai } = harness();
  const url = 'https://example.org/building';
  const photo = 'https://example.org/building.jpg';
  ai.runLogicModel = async () => ({ needsSearch: true, searchQuery: 'Casa Batlló', output: 'answer', imageIntent: 'illustrate' });
  ai.performSearch = async (_, options) => {
    assert.equal(options.includeImages, true);
    return { results: [{ url, images: [{ url: photo, description: 'Мозаичный фасад' }] }] };
  };
  const quote = 'The facade of Casa Batlló is covered with mosaics.';
  ai.extractUrl = async () => quote;
  const codeExample = '\x60\x60\x60html\n<img src="example.jpg">\n\x60\x60\x60';
  ai.openai.chat.completions.create = async () => ({ choices: [{ message: { content: 'На фасаде есть мозаика.\n\n![Подпись\nк фото](https://unknown.org/x.jpg)\n\n' + codeExample } }] });
  ai.reviewEvidence = async prompt => {
    if (prompt.startsWith('ПРОВЕРКА ГОТОВОГО ОТВЕТА')) {
      assert.match(prompt, /Мозаичный фасад/);
      assert.doesNotMatch(prompt, /unknown\.org/);
      assert.ok(prompt.includes(JSON.stringify(codeExample).slice(1, -1)));
      return { approved: false, addressesQuestion: true, answer: `Фасад покрыт мозаикой. [Источник](${url})`, imageIds: ['I1'] };
    }
    return { sufficient: true, addressesQuestion: true, claims: [{ claim: 'Фасад покрыт мозаикой.', quote, sourceId: 'S1', status: 'supported' }] };
  };
  const answer = await ai.getResponse([], { text: 'Расскажи об архитектуре дома Бальо', sender: 'Тест' });
  assert.match(answer, /Фасад покрыт мозаикой/);
  assert.ok(answer.includes(`<img src="${photo}"/>`));
  assert.doesNotMatch(answer, /tg-slideshow|unknown\.org/);
});

test('a photo-only reply still needs the auditor to confirm the subject and select a candidate', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'answer', searchQuery: 'Casa Batlló' });
  ai.performSearch = async () => ({ results: [], images: ['https://example.org/building.jpg'] });
  for (const audit of [
    { approved: false, addressesQuestion: true, imageIds: ['I1'] },
    { approved: true, addressesQuestion: false, imageIds: ['I1'] },
    { approved: true, addressesQuestion: true, imageIds: ['I9'] },
  ]) {
    ai.reviewEvidence = async () => audit;
    const answer = await ai.getResponse([], { text: 'Найди фото дома Бальо', sender: 'Тест' });
    assert.match(answer, /Подходящее фото подтвердить не удалось/);
    assert.doesNotMatch(answer, /<img|building\.jpg/);
  }
});

test('an auditor repair with its own link appendix is delivered with one source block', async () => {
  const { ai } = harness();
  const url = 'https://example.org/weather';
  const result = { claims: [{ claim: 'Сейчас −1 °C' }], foundSources: [{ url, title: 'Погода' }] };
  ai.reviewEvidence = async () => ({ approved: false, addressesQuestion: true,
    answer: `По [погоде](${url}) сейчас −1 °C.\n\n**Источники**\n1. [Погода](${url})` });
  const answer = await ai.finalizeResearchedAnswer('Черновик', result);
  assert.match(answer, /^По \[погоде\]/);
  assert.equal((answer.match(/Источники/g) || []).length, 1);
  assert.match(answer, /<details><summary>Источники<\/summary>/);
});

test('today for a current lookup does not become a publication filter', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'PHP RUB', topic: 'finance', timeRange: 'day' });
  const plan = await ai.checkSearchNeeded('Сыч, сколько сегодня 15000 филиппинских песо в рублях?', '', null);
  assert.equal(plan.output, 'lookup');
  assert.equal(plan.timeRange, null);
});

test('a parsed conversion uses its structured provider and the strict request keeps the audit', async () => {
  let directCalls = 0;
  const { ai, calls } = harness({ './quick-data': { quickData: async lookup => {
    directCalls++;
    assert.equal(lookup.base, 'PHP');
    assert.equal(lookup.quote, 'RUB');
    assert.equal(lookup.amount, 15000);
    return '15 000 PHP ≈ 19 478 ₽.';
  } } });
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'PHP RUB',
    lookup: { kind: 'currency', base: 'PHP', quote: 'RUB', amount: 15000 } });
  let searches = 0;
  ai.performSearch = async () => {
    searches++;
    return [{ url: 'https://example.org/countries', title: 'Fixture' }];
  };
  const input = { text: 'Сыч 15000 филипинских пессо это сколько сегодня в рублях?', sender: 'Тест' };
  assert.match(await ai.getResponse([], input), /19 478 ₽/);
  assert.equal(directCalls, 1);
  assert.equal(searches, 0);
  assert.equal(calls.length, 0);
  await ai.getResponse([], input, null, undefined, '', null, false, null, '', { failOnUnavailable: true });
  assert.equal(directCalls, 1);
  assert.equal(searches, 1);
  assert.equal(calls.length, 1);
});

test('a lookup declines a search result without a readable matching page', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'PHP RUB' });
  ai.performSearch = async () => [{ url: 'https://example.org/xau-idr', content: 'Unrelated provider excerpt' }];
  ai.extractUrl = async () => null;
  ai.reviewEvidence = async () => assert.fail('An unread snippet cannot answer a short lookup');
  const answer = await ai.getResponse([], { text: 'Сыч, сколько песо в рублях?', sender: 'Тест' });
  assert.match(answer, /Подходящих данных/);
  assert.doesNotMatch(answer, /xau-idr|Unrelated/);
  assert.equal(calls.length, 0);
});

test('a short lookup retains a current source value without inventing its observation time', async () => {
  const { ai, calls } = harness();
  const url = 'https://example.org/current-weather';
  const quote = 'Екатеринбург, погода сейчас: 0°, пасмурно, ощущается как −5°.';
  const navigation = 'Погода Екатеринбург сейчас. Другие города, меню и настройки.\n'.repeat(21);
  const forecast = '\nНедельный прогноз и другие данные. '.repeat(135);
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'Погода Екатеринбург сейчас' });
  ai.performSearch = async () => [{ url, title: 'Погода в Екатеринбурге' }];
  ai.extractUrl = async () => navigation + quote + forecast;
  ai.reviewEvidence = async prompt => {
    const [source] = JSON.parse(prompt.split('ИСТОЧНИКИ: ')[1]);
    if (!source.pageText.includes(quote) || !prompt.includes('точного времени обновления')) {
      return { claims: [], sufficient: false, addressesQuestion: true };
    }
    return { claims: [{ claim: 'По данным страницы, в Екатеринбурге около 0 °C и пасмурно, ощущается как −5 °C.',
      status: 'supported', sourceId: 'S1', quote }], sufficient: true, addressesQuestion: true };
  };
  const answer = await ai.getResponse([], { text: 'Сыч, какая погода в екатерибурге?', sender: 'Тест' });
  assert.match(answer, /около 0 °C и пасмурно, ощущается как −5 °C/);
  assert.ok(answer.includes(url));
  assert.equal(calls.length, 0);
});

test('a short weather lookup reviews the first pair again alongside one fresh result', async () => {
  const { ai, calls } = harness();
  const urls = Array.from({ length: 4 }, (_, index) => `https://example.org/weather-${index}`);
  const observation = 'Екатеринбург, 9 ноября 2026, 16:15: −4 °C.';
  const reads = [];
  const packs = [];
  let searches = 0;
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'Погода Екатеринбург сейчас' });
  ai.performSearch = async () => { searches++; return urls.map(url => ({ url, title: 'Погода' })); };
  ai.extractUrl = async url => { reads.push(url); return url === urls[2] ? observation : 'Екатеринбург: температура без времени.'; };
  ai.reviewEvidence = async (prompt, options) => {
    assert.equal(options.lookup, true);
    const pack = JSON.parse(prompt.split('ИСТОЧНИКИ: ')[1]);
    packs.push(pack);
    if (packs.length === 1) return { claims: [], sufficient: false, addressesQuestion: true };
    return { claims: [{ claim: 'В Екатеринбурге в 16:15 было −4 °C.', status: 'supported', sourceId: 'S3',
      quote: observation }], sufficient: true, addressesQuestion: true };
  };
  const answer = await ai.getResponse([], { text: 'Сыч, какая погода в екатерибурге?', sender: 'Тест' });
  assert.match(answer, /16:15 было −4 °C/);
  assert.ok(answer.includes(urls[2]));
  assert.deepEqual(reads, urls.slice(0, 3));
  assert.deepEqual(packs.map(pack => pack.map(row => row.url)), [urls.slice(0, 2), urls.slice(0, 3)]);
  assert.equal(searches, 1);
  assert.equal(calls.length, 0);
});

test('a named rate provider takes precedence over the default currency adapter', async () => {
  const { ai } = harness({ './quick-data': { quickData: async () => assert.fail('The user specified another provider') } });
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'USD RUB CBR',
    lookup: { kind: 'currency', base: 'USD', quote: 'RUB', amount: 1 }, preferredDomains: ['www.cbr.ru'] });
  ai.performSearch = async (_, options) => {
    assert.deepEqual([...options.requiredDomains], ['cbr.ru']);
    return [{ url: 'https://example.org/rate' }, { url: 'https://www.cbr.ru/rate' }];
  };
  ai.extractUrl = async url => { assert.equal(url, 'https://www.cbr.ru/rate'); return 'Доллар США USD 80,00.'; };
  ai.reviewEvidence = async () => ({ claims: [{ claim: 'Один доллар стоит 80,00 ₽.', status: 'supported',
    sourceId: 'S2', quote: 'Доллар США USD 80,00.' }], sufficient: true, addressesQuestion: true });
  const answer = await ai.getResponse([], { text: 'Сыч, проверь курс доллара по данным ЦБ РФ', sender: 'Тест' });
  assert.match(answer, /\[Источник\]\(https:\/\/www\.cbr\.ru\/rate\)/);
  assert.doesNotMatch(answer, /Frankfurter|example\.org/);
});

test('a planner cannot use a quick lookup for an explicit fact check or a comparison', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'test', lookup: { kind: 'currency' } });
  for (const question of ['Сыч, проверь мою теорию про Anthropic', 'Сыч, сравни тарифы двух банков', 'Сыч, почему упал курс?']) {
    const plan = await ai.checkSearchNeeded(question, '', null);
    assert.equal(plan.output, 'answer', question);
  }
});

test('questions phrased without a search verb still preserve a website and a publication window', async () => {
  const { ai } = harness();
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'quote' });
  const website = await ai.checkSearchNeeded('Сыч, какой сейчас курс USD/RUB на xe.com?', '', null);
  assert.deepEqual([...website.requiredDomains], ['xe.com']);
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'Node releases', timeRange: 'day' });
  const period = await ai.checkSearchNeeded('Сыч, сколько релизов Node вышло за последнюю неделю?', '', null);
  assert.equal(period.requiredTimeRange, 'week');
  assert.equal(period.timeRange, 'week');
});

test('native search keeps links without attaching other sources’ evidence', async () => {
  const { ai } = harness();
  ai.keys = ['synthetic'];
  ai.executeNativeWithRetry = async work => work();
  ai.nativeModel = { generateContent: async () => ({ response: { candidates: [{ groundingMetadata: {
    groundingChunks: [{ web: { uri: 'https://example.org/first' } }, { web: { uri: 'https://example.org/second' } }],
    groundingSupports: [{ groundingChunkIndices: [0], segment: { text: 'First source statement.' } }],
  } }] } }) };
  const results = await ai.searchViaNative('synthetic fixture');
  assert.deepEqual(Array.from(results, row => [row.url, row.content]), [
    ['https://example.org/first', 'First source statement.'], ['https://example.org/second', ''],
  ]);
});

test('banter skips research and keeps original personality and generation temperature', async () => {
  const { ai, calls } = harness();
  ai.runLogicModel = async () => ({ needsSearch: false });
  ai.performSearch = async () => { throw Error('Banter must not research'); };
  await ai.getResponse([], { text: 'Сыч, пошути про свой щебетальник', sender: 'Тест' });
  assert.equal(calls[0].temperature, 0.9);
  assert.match(calls[0].messages[0].content, /можешь и послать \(любя\)/);
  assert.match(calls[0].messages[0].content, /используй сленг, мат/);
  assert.doesNotMatch(calls[0].messages[1].content[0].text, /РЕЗУЛЬТАТ ПРОВЕРКИ/);
});

test('writer fallback preserves gathered evidence and disables a new unreviewed search', async () => {
  const { ai } = harness();
  ai.openai.chat.completions.create = async () => { throw Error('writer offline'); };
  ai.keys = ['test'];
  let nativeRequest;
  ai.nativeModel = { generateContent: async request => {
    nativeRequest = request;
    return { response: { text: () => 'Native answer [Источник](https://example.org/countries)', candidates: [{}] } };
  } };
  const answer = await ai.getResponse([], { text: 'Сыч, антропики продают подписки казахам?', sender: 'Тест' });
  assert.equal(answer.split('\n\n<details>')[0], 'Native answer [Источник](https://example.org/countries)');
  assert.match(answer, /<details>[\s\S]*<summary>Источники<\/summary>/);
  assert.equal(nativeRequest.tools.length, 0);
  assert.match(nativeRequest.contents[0].parts[0].text, /Kazakhstan supported/);
  assert.match(nativeRequest.contents[0].parts[0].text, /No guarantee for a card/);
  assert.equal(nativeRequest.generationConfig.temperature, 0.9);
});

test('search outage reaches both writers as missing evidence, never silently as a normal factual answer', async () => {
  const { ai, calls } = harness();
  ai.performSearch = async () => [];
  const answer = await ai.getResponse([], { text: 'Сыч проверь новость', sender: 'Тест' });
  assert.match(answer, /Подтвердить .*не удалось/);
  assert.equal(calls.length, 0);
});

test('public composition fails privately instead of returning a research error for publication', async () => {
  const { ai, calls } = harness();
  ai.performSearch = async () => [];
  await assert.rejects(ai.getResponse([], { text: 'Сыч проверь новость', sender: 'Сыч' },
    null, undefined, '', null, false, null, '', { failOnUnavailable: true }), /PUBLIC_RESPONSE_UNAVAILABLE/);
  assert.equal(calls.length, 0);
});

test('public composition rejects unavailable verification in both writer paths', async () => {
  const { ai } = harness();
  ai.reviewEvidence = async prompt => prompt.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА') ? null
    : { claims: [{ claim: 'Kazakhstan supported.', status: 'supported', sourceId: 'S1', quote: 'Kazakhstan is supported for Claude.ai.' }], sufficient: true };
  const input = { text: 'Сыч проверь поддерживаемые страны', sender: 'Сыч' };
  await assert.rejects(ai.getResponse([], input, null, undefined, '', null, false, null, '',
    { failOnUnavailable: true }), /PUBLIC_RESPONSE_UNAVAILABLE/);
  ai.openai.chat.completions.create = async () => { throw Error('Writer offline'); };
  ai.keys = ['synthetic'];
  ai.nativeModel = { generateContent: async () => ({ response: { text: () => 'Draft answer', candidates: [{}] } }) };
  await assert.rejects(ai.getResponse([], input, null, undefined, '', null, false, null, '',
    { failOnUnavailable: true }), /PUBLIC_RESPONSE_UNAVAILABLE/);
});

test('approved researched answers can link to any domain outside the source-page URLs', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'A source reports the project.', status: 'supported', url: 'https://example.org/article' }], gaps: [], errors: [] };
  ai.reviewEvidence = async () => ({ approved: true, addressesQuestion: true });
  for (const url of ['https://t.me/abstractDL', 'https://news.example.net/report', 'https://downloads.example.net/release.zip', 'https://another.example.com/Policy_(service)?version=2#section']) {
    const answer = `Вот найденная ссылка: [Открыть](${url}).`;
    assert.equal(await ai.finalizeResearchedAnswer(answer, result), answer);
  }
});

test('Ouroboros Telegram link survives review when its proof is on a different page', async () => {
  const { ai } = harness();
  const result = { question: 'сыч кто урабороса сделал дай ссылку на телегу', claims: [{
    claim: 'Telegram-канал автора проекта Антона Разжигаева — https://t.me/abstractDL.',
    status: 'supported', sourceId: 'S1', url: 'https://habr.com/ru/companies/airi/articles/1065428',
    quote: 'мой Telegram-канал: <https://t.me/abstractDL>',
  }], gaps: [], errors: [] };
  ai.reviewEvidence = async () => ({ approved: true, addressesQuestion: true, issues: [], answer: '' });
  const answer = 'Канал Антона Разжигаева: [@abstractDL](https://t.me/abstractDL).';
  assert.equal(await ai.finalizeResearchedAnswer(answer, result), answer);
});

test('answer audit can return a repaired answer with links outside source-page URLs', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'A source identifies the author channel.', status: 'supported', url: 'https://example.org/article' }], gaps: [], errors: [] };
  const repaired = 'Вот канал автора: [Открыть](https://t.me/abstractDL).';
  ai.reviewEvidence = async () => ({ approved: false, addressesQuestion: true, answer: repaired });
  assert.equal(await ai.finalizeResearchedAnswer('Wrong draft.', result), repaired);
});

test('failed or invalid answer auditing never releases an unchecked draft', async () => {
  const { ai } = harness();
  const result = { claims: [{ claim: 'Kazakhstan supported.', status: 'supported', url: 'https://example.org/countries' }], gaps: [], errors: [] };
  ai.reviewEvidence = async () => { throw Error('audit offline'); };
  assert.match(await ai.finalizeResearchedAnswer('Definitely banned!', result), /Проверку ответа завершить не удалось/);
  for (const audit of [null, {}, { approved: false, answer: '' }, { approved: 'true' }]) {
    ai.reviewEvidence = async () => audit;
    assert.match(await ai.finalizeResearchedAnswer('Definitely banned!', result), /Проверку ответа завершить не удалось/);
  }
  ai.reviewEvidence = async () => ({ approved: false, addressesQuestion: true, answer: 'Один [пост](https://example.org/countries) — ещё не доказательство.' });
  assert.equal(await ai.finalizeResearchedAnswer('Definitely banned!', result), 'Один [пост](https://example.org/countries) — ещё не доказательство.');
});

function timedHarness() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  class ClockDate extends Date { static now() { return now; } }
  const asyncBox = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/async.js'), 'utf8'), {
    module: asyncBox, setTimeout: setTimer, clearTimeout: clearTimer,
  });
  const researchBox = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/research.js'), 'utf8'), {
    module: researchBox, URL, Date: ClockDate, console: { log() {} },
    require: name => name === '../utils/async' ? asyncBox.exports
      : name === '../utils/quotes' ? require('../src/utils/quotes') : require(name),
  });
  const context = harness({ '../utils/async': asyncBox.exports, './research': researchBox.exports },
    { Date: ClockDate, setTimeout: setTimer, clearTimeout: clearTimer });
  context.ai.reviewEvidence = Object.getPrototypeOf(context.ai).reviewEvidence.bind(context.ai);
  context.ai.keys = ['synthetic'];
  context.ai.executeNativeWithRetry = fn => fn();
  context.events = [];
  context.delay = (ms, signal, value, reject = false) => new Promise((resolve, fail) => {
    const timer = setTimer(() => reject ? fail(new Error('Request timed out.')) : resolve(value), ms);
    signal?.addEventListener('abort', () => { clearTimer(timer); fail(new Error('aborted')); }, { once: true });
  });
  context.clock = () => now;
  context.drive = async work => {
    let complete = false, value, error;
    work.then(v => { complete = true; value = v; }, e => { complete = true; error = e; });
    for (let n = 0; n < 80 && !complete; n++) {
      await new Promise(setImmediate);
      if (complete) break;
      const first = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
      assert.ok(first, 'pending work must have a bounded timer');
      now = first[1].at; timers.delete(first[0]); first[1].fn();
    }
    assert.ok(complete, 'operation must settle within the bounded schedule');
    if (error) throw error;
    return value;
  };
  return context;
}

test('an extra lookup page shares the original deadline and cannot start a late review', async () => {
  const context = timedHarness();
  const { ai, drive, delay } = context;
  const urls = Array.from({ length: 4 }, (_, index) => `https://example.org/weather-${index}`);
  const reads = [];
  let reviews = 0;
  ai.runLogicModel = async () => ({ needsSearch: true, output: 'lookup', searchQuery: 'weather' });
  ai.performSearch = async () => urls.map(url => ({ url, title: 'Weather' }));
  ai.extractUrl = async url => { reads.push(url); return url === urls[2] ? new Promise(() => {}) : 'Weather without a dated value.'; };
  ai.reviewEvidence = async () => {
    reviews++;
    return delay(21000, undefined, { claims: [], sufficient: false, addressesQuestion: true });
  };
  const answer = await drive(ai.getResponse([], { text: 'Сыч, какая сейчас погода?', sender: 'Тест' }));
  assert.equal(context.clock(), 22000);
  assert.deepEqual(reads, urls.slice(0, 3));
  assert.equal(reviews, 1);
  assert.match(answer, /Подходящих данных/);
});

test('a stalled source intro is aborted at five seconds and preserves the open links', async () => {
  const context = timedHarness();
  const { ai, drive, delay } = context;
  const result = { foundSources: [{ title: 'Original', url: 'https://example.org/page' }] };
  let options;
  ai.openai.chat.completions.create = (_, requestOptions) => {
    options = requestOptions;
    return delay(100000, options.signal, null);
  };
  const answer = await drive(ai.renderSourceReply(result, 'Сыч, проверь новость', 'audit'));
  assert.match(answer, /^<details open>[\s\S]*Проверка ответа прервалась\.[\s\S]*example\.org\/page/);
  assert.equal(context.clock(), 5000);
  assert.equal(options.timeout, 5000);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.signal.aborted, true);
});

test('a slow primary reviewer leaves time for native evidence and final-answer auditing', async () => {
  const context = timedHarness();
  const { ai, events, delay, drive } = context;
  ai.openai.chat.completions.create = (body, options) => {
    if (!options) return Promise.resolve({ choices: [{ message: { content: 'Проверенный ответ [Источник](https://example.org/countries)' } }] });
    events.push({ provider: 'primary', at: context.clock(), timeout: options.timeout, signal: options.signal });
    return delay(options.timeout, options.signal, null, true);
  };
  ai.nativeModel = { generateContent: (request, options) => {
    events.push({ provider: 'native', at: context.clock(), timeout: options?.timeout, signal: options?.signal });
    const audit = request.contents[0].parts[0].text.includes('ПРОВЕРКА ГОТОВОГО ОТВЕТА');
    return delay(5000, options?.signal, { response: { candidates: [{ finishReason: 'STOP' }], text: () => JSON.stringify(audit ? { approved: true, addressesQuestion: true } : {
      claims: [{ claim: 'Kazakhstan supported.', status: 'supported', sourceId: 'S1', quote: 'Kazakhstan is supported for Claude.ai.' }], sufficient: true,
    }) } });
  } };
  const answer = await drive(ai.getResponse([], { text: 'Сыч, проверь актуальную информацию', sender: 'Тест' }));
  assert.equal(answer.split('\n\n<details>')[0], 'Проверенный ответ [Источник](https://example.org/countries)');
  assert.match(answer, /<details>[\s\S]*<summary>Источники<\/summary>/);
  assert.equal(events.filter(e => e.provider === 'native').length, 2);
  assert.ok(events.every(e => e.signal instanceof AbortSignal));
  assert.ok(events.filter(e => e.provider === 'native').every(e => e.timeout >= 15000));
  assert.ok(context.clock() <= 80000);
});

test('review deadlines abort both providers and shortened caller budgets preserve a native reserve', async () => {
  const context = timedHarness();
  const { ai, events, delay, drive } = context;
  ai.openai.chat.completions.create = (_, options) => {
    events.push(options);
    return delay(100000, options.signal, null);
  };
  ai.nativeModel = { generateContent: (_, options = {}) => {
    events.push(options);
    return delay(100000, options.signal, null);
  } };
  await assert.rejects(drive(ai.reviewEvidence('Synthetic evidence', { timeoutMs: 12000 })), /провер|review/i);
  assert.equal(context.clock(), 12000);
  assert.equal(events.length, 2);
  assert.ok(events[0].timeout <= 5400);
  assert.ok(events[1].timeout >= 6600);
  assert.ok(events.every(e => e.signal?.aborted));
});

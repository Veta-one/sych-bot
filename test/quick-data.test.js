const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { quickData } = require('../src/services/quick-data');

const now = new Date('2026-11-09T20:30:00Z');
const city = { id: 1, name: 'Верхняя Пышма', admin1: 'Свердловская область', country: 'Россия',
  country_code: 'RU', feature_code: 'PPL', latitude: 56.97, longitude: 60.58, timezone: 'Asia/Yekaterinburg' };
const current = { timezone: city.timezone, utc_offset_seconds: 18000,
  current_units: { temperature_2m: '°C', apparent_temperature: '°C', wind_speed_10m: 'm/s' },
  current: { time: '2026-11-10T01:30', temperature_2m: -4.5, apparent_temperature: -8.2, wind_speed_10m: 3.2, weather_code: 71 } };
const daily = { timezone: city.timezone, utc_offset_seconds: 18000,
  daily_units: { temperature_2m_min: '°C', temperature_2m_max: '°C', precipitation_probability_max: '%', wind_speed_10m_max: 'm/s' },
  daily: { time: ['2026-11-11'], temperature_2m_min: [-8], temperature_2m_max: [-2], weather_code: [3],
    precipitation_probability_max: [65], wind_speed_10m_max: [4.1] } };
const weather = { kind: 'weather', place: city.name, region: city.admin1, period: 'current' };
const currency = { kind: 'currency', base: 'PHP', quote: 'RUB', amount: 15000 };
function mockFetch(...bodies) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    assert.ok(bodies.length, 'No unplanned provider calls');
    const body = bodies.shift();
    if (body instanceof Error) throw body;
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

test('currency uses the exact pair, deterministic amount, actual rate date and a provider link', async () => {
  const { fetch, calls } = mockFetch({ date: '2026-11-06', base: 'PHP', quote: 'RUB', rate: 1.42 });
  const answer = await quickData(currency, { fetch, now });
  assert.match(answer, /15\s*000 PHP ≈ 21\s*300,00 RUB/);
  assert.match(answer, /1 PHP = 1,42 RUB/);
  assert.match(answer, /Курс за 2026-11-06/);
  assert.match(answer, /справочному курсу/);
  assert.doesNotMatch(answer, /\n/);
  assert.match(answer, /\[Frankfurter\]\(https:\/\/api\.frankfurter\.dev\/v2\/rate\/PHP\/RUB\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/v2/rate/PHP/RUB');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal.aborted, 'Release the shared controller after completion');
});

test('historical dates retain the requested day and the earlier available observation without inventing freshness', async () => {
  const { fetch, calls } = mockFetch({ date: '2026-11-06', base: 'PHP', quote: 'RUB', rate: 1.42 });
  const answer = await quickData({ ...currency, date: '2026-11-08' }, { fetch, now });
  assert.equal(calls[0].url.searchParams.get('date'), '2026-11-08');
  assert.match(answer, /Запрос на 2026-11-08/);
  assert.match(answer, /Курс за 2026-11-06/);
});

test('decimal multiplication rounds money without binary floating-point artefacts', async () => {
  const { fetch } = mockFetch({ date: '2026-11-09', base: 'USD', quote: 'EUR', rate: 1.005 });
  assert.match(await quickData({ kind: 'currency', base: 'USD', quote: 'EUR', amount: 1 }, { fetch, now }), /1 USD ≈ 1,01 EUR/);
});

test('invalid arguments never call a provider', async () => {
  for (const lookup of [null, {}, { kind: 'news' }, { ...weather, place: '' }, { ...weather, period: 'next-week' },
    { ...weather, place: 'Paris, France, Texas' }, { ...currency, base: '../USD' }, { ...currency, amount: Infinity },
    { ...currency, amount: -1 }, { ...currency, amount: '15000' }, { ...currency, date: '2026-02-30' },
    { ...currency, date: '2026-11-10' }, { ...currency, date: 'tomorrow' }]) {
    assert.equal(await quickData(lookup, { fetch: () => assert.fail('Invalid lookup called fetch'), now }), '');
  }
});

test('wrong pair, invalid date/rate and provider failures return empty without exposing payload', async () => {
  for (const body of [null, [], { date: '2026-11-09', base: 'PHP', quote: 'USD', rate: 1.42 },
    { date: '2026-11-10', base: 'PHP', quote: 'RUB', rate: 1.42 },
    { date: '2026-02-30', base: 'PHP', quote: 'RUB', rate: 1.42 },
    { date: '2026-11-09', base: 'PHP', quote: 'RUB', rate: 0 },
    { date: '2026-11-09', base: 'PHP', quote: 'RUB', rate: '1.42' }, new Error('PRIVATE_PROVIDER_PAYLOAD')]) {
    assert.equal(await quickData(currency, { ...mockFetch(body), now }), '');
  }
  assert.equal(await quickData(currency, { fetch: async () => ({ ok: false }), now }), '');
  assert.equal(await quickData(currency, { fetch: async () => ({ ok: true, text: async () => 'not JSON' }), now }), '');
});

test('current weather preserves local observation time, units, model origin and resolved place', async () => {
  const { fetch, calls } = mockFetch({ results: [city] }, current);
  const answer = await quickData(weather, { fetch, now });
  assert.match(answer, /Верхняя Пышма, Свердловская область, Россия/);
  assert.match(answer, /-4,5 °C/);
  assert.match(answer, /ощущается как -8,2 °C/);
  assert.match(answer, /3,2 м\/с/);
  assert.match(answer, /снег/);
  assert.match(answer, /2026-11-10 01:30.*UTC\+05:00/);
  assert.match(answer, /модел/);
  assert.match(answer, /\[Open-Meteo\]\(https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.equal(calls[0].url.searchParams.get('name'), 'Верхняя Пышма, Свердловская область');
  assert.equal(calls[0].url.searchParams.get('language'), 'ru');
  assert.equal(calls[1].url.searchParams.get('wind_speed_unit'), 'ms');
  assert.equal(calls[1].options.signal, calls[0].options.signal);
});

test('today and tomorrow follow the place local calendar, not the server UTC date', async () => {
  for (const [period, date] of [['today', '2026-11-10'], ['tomorrow', '2026-11-11']]) {
    const { fetch, calls } = mockFetch({ results: [city] }, { ...daily, daily: { ...daily.daily, time: [date] } });
    const answer = await quickData({ ...weather, period }, { fetch, now });
    assert.match(answer, new RegExp(date));
    assert.match(answer, /65 %/);
    assert.match(answer, /от -8 до -2 °C/);
    assert.equal(calls[1].url.searchParams.get('start_date'), date);
    assert.equal(calls[1].url.searchParams.get('end_date'), date);
  }
});

test('ambiguous cities, prefix matches and mismatched regions never trigger a forecast', async () => {
  for (const [lookup, results] of [
    [{ ...weather, region: undefined }, [city, { ...city, id: 2, longitude: 61 }]],
    [weather, [{ ...city, name: 'Нижняя Пышма' }]],
    [weather, [{ ...city, admin1: 'Московская область' }]],
    [weather, [{ ...city, feature_code: 'MT' }]],
    [weather, []],
  ]) {
    const { fetch, calls } = mockFetch({ results });
    assert.equal(await quickData(lookup, { fetch, now }), '');
    assert.equal(calls.length, 1);
  }
  const { fetch } = mockFetch({ results: [{ ...city, id: 2, admin1: 'Московская область' }, city] }, current);
  assert.match(await quickData(weather, { fetch, now }), /Верхняя Пышма/);
});

test('an explicit comma qualifier and duplicate rows resolve without changing the requested place', async () => {
  const { fetch, calls } = mockFetch({ results: [city, { ...city }] }, current);
  const answer = await quickData({ kind: 'weather', place: `${city.name}, ${city.admin1}`, period: 'current' }, { fetch, now });
  assert.ok(answer);
  assert.equal(calls[0].url.searchParams.get('name'), `${city.name}, ${city.admin1}`);
});

test('weather rejects stale observations, unexpected units and wrong forecast day', async () => {
  for (const response of [
    { ...current, current: { ...current.current, time: '2026-11-09T01:30' } },
    { ...current, current_units: { ...current.current_units, temperature_2m: '°F' } },
    { ...current, current: { ...current.current, temperature_2m: null } },
    { ...current, timezone: 'Europe/London' },
  ]) assert.equal(await quickData(weather, { ...mockFetch({ results: [city] }, response), now }), '');
  assert.equal(await quickData({ ...weather, period: 'today' }, { ...mockFetch({ results: [city] }, daily), now }), '');
});

test('provider location labels cannot inject markup, control characters or oversized output', async () => {
  const location = { ...city, country: '<script>bad</script> [link](https://example.org/evil)\n\u202e' + 'x'.repeat(5000) };
  const answer = await quickData(weather, { ...mockFetch({ results: [location] }, current), now });
  assert.ok(answer);
  assert.doesNotMatch(answer, /<script>|\u202e|\n{3}/);
  assert.ok(answer.length < 1200);
  assert.equal((answer.match(/(?<!\\)\[[^\]]+\]\(https:/g) || []).length, 1);
});

test('oversized responses are rejected instead of publishing provider payload', async () => {
  assert.equal(await quickData(currency, { ...mockFetch({ payload: 'x'.repeat(262145) }), now }), '');
});

test('one shared deadline aborts a stalled body and does not start a late second request', async () => {
  const timers = new Map(); let sequence = 0;
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/quick-data.js'), 'utf8'), {
    module: box, URL, URLSearchParams, Date, Intl, AbortController,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  let calls = 0, signal, finishBody;
  const pending = box.exports.quickData(weather, { now, fetch: async (_, options) => {
    calls++; signal = options.signal;
    return { ok: true, text: () => new Promise(resolve => { finishBody = resolve; }) };
  } });
  for (let n = 0; n < 5; n++) await Promise.resolve();
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.ms, 8000);
  timer.fn();
  assert.equal(await pending, '');
  assert.equal(signal.aborted, true);
  finishBody(JSON.stringify({ results: [city] }));
  for (let n = 0; n < 5; n++) await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(timers.size, 0);
});

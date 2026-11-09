// Fixed public providers only. Open-Meteo's free endpoint is non-commercial:
// https://open-meteo.com/en/terms . The caller controls whether it may be used.
const BUDGET_MS = 8000;
const MAX_BODY_CHARS = 262144;
const WEATHER_CODES = {
  0: 'ясно', 1: 'преимущественно ясно', 2: 'переменная облачность', 3: 'пасмурно',
  45: 'туман', 48: 'туман с изморозью', 51: 'слабая морось', 53: 'морось', 55: 'сильная морось',
  56: 'слабая переохлаждённая морось', 57: 'сильная переохлаждённая морось',
  61: 'слабый дождь', 63: 'дождь', 65: 'сильный дождь', 66: 'слабый ледяной дождь', 67: 'сильный ледяной дождь',
  71: 'слабый снег', 73: 'снег', 75: 'сильный снег', 77: 'снежные зёрна',
  80: 'слабый ливень', 81: 'ливень', 82: 'сильный ливень', 85: 'снежный ливень', 86: 'сильный снежный ливень',
  95: 'гроза', 96: 'гроза с градом', 97: 'сильная гроза', 99: 'сильная гроза с градом',
};
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 20 }).format(value);
const literal = value => [...String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')].slice(0, 120).join('')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_[\]{}()#!|~]/g, '\\$&');
const normalized = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/ё/g, 'е').replace(/\s+/gu, ' ').trim();

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function decimal(value) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const fraction = (mantissa.split('.')[1] || '').length;
  const scale = fraction - Number(exponent);
  return { integer: BigInt(mantissa.replace('.', '')) * 10n ** BigInt(Math.max(0, -scale)), scale: Math.max(0, scale) };
}

// Multiply the provider's decimal rate, then round half up to two decimals.
function convertedAmount(amount, rate) {
  const a = decimal(amount), b = decimal(rate);
  const product = a.integer * b.integer;
  const scale = a.scale + b.scale;
  const divisor = 10n ** BigInt(Math.max(0, scale - 2));
  const cents = scale > 2 ? (product + divisor / 2n) / divisor : product * 10n ** BigInt(2 - scale);
  const digits = cents.toString().padStart(3, '0');
  return digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + digits.slice(-2);
}

function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

function locationQuery(lookup) {
  const valid = value => typeof value === 'string' && value.trim().length >= 2 && value.length <= 120
    && !/[\p{Cc}\p{Cf}<>\r\n]/u.test(value);
  if (!valid(lookup.place) || !['current', 'today', 'tomorrow'].includes(lookup.period)) return null;
  const pieces = lookup.place.split(',').map(part => part.trim());
  if (pieces.length > 2 || !valid(pieces[0]) || (pieces.length === 2 && !valid(pieces[1]))) return null;
  if (lookup.region != null && (!valid(lookup.region) || lookup.region.includes(','))) return null;
  if (lookup.region && pieces[1] && normalized(lookup.region) !== normalized(pieces[1])) return null;
  return { place: pieces[0], region: lookup.region?.trim() || pieces[1] || '' };
}

async function currencyData(lookup, request, now) {
  const { base, quote, amount, date } = lookup;
  const today = now.toISOString().slice(0, 10);
  if (typeof base !== 'string' || typeof quote !== 'string' || !/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)
    || !finite(amount, 0, 1e12) || decimal(amount).scale > 8
    || (date != null && (!validDate(date) || date > today))) return '';
  const url = new URL(`https://api.frankfurter.dev/v2/rate/${base}/${quote}`);
  if (date) url.searchParams.set('date', date);
  const row = await request(url);
  if (!row || row.base !== base || row.quote !== quote || !validDate(row.date) || row.date > (date || today)
    || !finite(row.rate, Number.MIN_VALUE, 1e12) || (base === quote && row.rate !== 1)) return '';
  const requested = date && date !== row.date ? ` Запрос на ${date}.` : '';
  return `${number(amount)} ${base} ≈ ${convertedAmount(amount, row.rate)} ${quote} по справочному курсу [Frankfurter](${url.href}). `
    + `Курс за ${row.date}: 1 ${base} = ${number(row.rate)} ${quote}.${requested}`;
}

async function weatherData(lookup, request, now) {
  const query = locationQuery(lookup);
  if (!query) return '';
  const geocoding = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geocoding.search = new URLSearchParams({ name: query.place + (query.region ? `, ${query.region}` : ''), count: '100', language: 'ru', format: 'json' });
  const locations = await request(geocoding);
  const matches = new Map();
  for (const row of Array.isArray(locations?.results) ? locations.results : []) {
    if (!row || normalized(row.name) !== normalized(query.place) || !/^PPL/.test(row.feature_code || '')
      || !finite(row.latitude, -90, 90) || !finite(row.longitude, -180, 180) || typeof row.timezone !== 'string') continue;
    if (query.region && ![row.admin1, row.admin2, row.admin3, row.admin4, row.country, row.country_code]
      .some(region => normalized(region) === normalized(query.region))) continue;
    matches.set(`${row.latitude},${row.longitude}`, row);
  }
  if (matches.size !== 1) return '';
  const city = [...matches.values()][0];
  const today = localDate(now, city.timezone); // Also validates the IANA time zone.
  const day = lookup.period === 'tomorrow'
    ? new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : today;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  const params = { latitude: String(city.latitude), longitude: String(city.longitude), timezone: city.timezone,
    temperature_unit: 'celsius', wind_speed_unit: 'ms', precipitation_unit: 'mm' };
  if (lookup.period === 'current') {
    params.current = 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m';
    params.forecast_days = '1';
  } else {
    params.daily = 'temperature_2m_min,temperature_2m_max,weather_code,precipitation_probability_max,wind_speed_10m_max';
    params.start_date = day;
    params.end_date = day;
  }
  url.search = new URLSearchParams(params);
  const data = await request(url);
  if (!data || data.timezone !== city.timezone || !Number.isInteger(data.utc_offset_seconds)
    || !finite(data.utc_offset_seconds, -43200, 50400)) return '';
  const place = [...new Set([city.name, city.admin1, city.country].filter(value => typeof value === 'string' && value))]
    .map(literal).join(', ');
  let text;
  if (lookup.period === 'current') {
    const row = data.current, units = data.current_units;
    if (!row || !units || units.temperature_2m !== '°C' || units.apparent_temperature !== '°C' || units.wind_speed_10m !== 'm/s'
      || !finite(row.temperature_2m, -150, 150) || !finite(row.apparent_temperature, -150, 150)
      || !finite(row.wind_speed_10m, 0, 200) || !Object.hasOwn(WEATHER_CODES, row.weather_code)
      || typeof row.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time)
      || !validDate(row.time.slice(0, 10))) return '';
    const observed = Date.parse(row.time + ':00Z') - data.utc_offset_seconds * 1000;
    if (observed > now.getTime() + 900000 || observed < now.getTime() - 7200000) return '';
    const offset = Math.abs(data.utc_offset_seconds / 60);
    const timezone = `UTC${data.utc_offset_seconds < 0 ? '-' : '+'}${String(Math.floor(offset / 60)).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')}`;
    text = `${place}: ${number(row.temperature_2m)} °C, ${WEATHER_CODES[row.weather_code]}, ощущается как ${number(row.apparent_temperature)} °C. Ветер ${number(row.wind_speed_10m)} м/с.\n`
      + `Данные модели на ${row.time.replace('T', ' ')} (${timezone}).`;
  } else {
    const row = data.daily, units = data.daily_units;
    if (!row || !units || units.temperature_2m_min !== '°C' || units.temperature_2m_max !== '°C'
      || units.precipitation_probability_max !== '%' || units.wind_speed_10m_max !== 'm/s'
      || !Array.isArray(row.time) || row.time.length !== 1 || row.time[0] !== day) return '';
    const low = row.temperature_2m_min?.[0], high = row.temperature_2m_max?.[0];
    const chance = row.precipitation_probability_max?.[0], wind = row.wind_speed_10m_max?.[0], code = row.weather_code?.[0];
    if (!finite(low, -150, 150) || !finite(high, -150, 150) || low > high || !finite(chance, 0, 100)
      || !finite(wind, 0, 200) || !Object.hasOwn(WEATHER_CODES, code)) return '';
    text = `${place}, ${lookup.period === 'tomorrow' ? 'завтра' : 'сегодня'} (${day}): от ${number(low)} до ${number(high)} °C, ${WEATHER_CODES[code]}.\n`
      + `Вероятность осадков до ${number(chance)} %, ветер до ${number(wind)} м/с. Прогноз по местному времени.`;
  }
  return `${text}\n\n[Open-Meteo](${url.href}) · Получено ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
}

async function quickData(lookup, { fetch = globalThis.fetch, now = new Date() } = {}) {
  if (!lookup || typeof lookup !== 'object' || !['weather', 'currency'].includes(lookup.kind) || typeof fetch !== 'function') return '';
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) return '';
  const controller = new AbortController();
  let timer;
  const request = async url => {
    if (controller.signal.aborted) throw new Error('QUICK_DATA_CANCELLED');
    const response = await fetch(url.href, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok || controller.signal.aborted) throw new Error('QUICK_DATA_UNAVAILABLE');
    const size = Number(response.headers?.get('content-length'));
    if (size > MAX_BODY_CHARS) throw new Error('QUICK_DATA_TOO_LARGE');
    const body = await response.text();
    if (controller.signal.aborted || body.length > MAX_BODY_CHARS) throw new Error('QUICK_DATA_UNAVAILABLE');
    return JSON.parse(body);
  };
  try {
    return await Promise.race([
      lookup.kind === 'weather' ? weatherData(lookup, request, now) : currencyData(lookup, request, now),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(''); }, BUDGET_MS); }),
    ]);
  } catch { return ''; }
  finally { clearTimeout(timer); controller.abort(); }
}

module.exports = { quickData };

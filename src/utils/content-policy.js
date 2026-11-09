function isVerificationRequest(message) {
  const text = String(message || '');
  if (/проверь.{0,40}(?:орфограф|граммат|пунктуац|арифметик|вычислен|расч[её]т|формул|код|тесты)/i.test(text)
    && !/интернет|в сети|первоисточник|правдив|актуальн|достовер/i.test(text)) return false;
  return /(?:проверь|перепроверь|проверить|правдив|достовер|фактчек|факт.?чек|это правда|правда ли|ты уверен|точно\?|откуда (?:ты )?(?:это|взял|инф)|подтверди|доказательств|первоисточник|нагугли|загугли|найди.{0,35}(?:ссылк|источник)|поищи|погугли|fact.?check|verify|are you sure)/i.test(text);
}

function searchRequestIntent(userMessage) {
  // Only the user's bounded request is authoritative, never attached source text.
  const text = typeof userMessage === 'string' ? userMessage.slice(0, 8000).toLowerCase() : '';
  const empty = { explicitSearch: false, output: null, requiredDomains: [], requiredTimeRange: null };
  const action = /(?<![а-яёa-z])(?:найди|найти|отыщи|поищи|ищи|подбери|посоветуй|порекомендуй|покажи|дай|пришли|сравни|проверь|search|find|recommend|look up)(?![а-яёa-z])/i.test(text);
  const domains = [];
  // A site is a constraint only when named as the place to search, not as a product.
  const locations = /(?:^|[\s,(])(?:на|в|с|по(?:\s+(?:версии|мнению|обсуждениям))?|on|in|from)\s+(?:(?:сайте|сайта|платформе)\s+)?(?:https?:\/\/)?((?:[a-z0-9-]{1,63}\.){1,6}[a-z]{2,63}|github|гитхаб[еа]?|гит[еа]|reddit|редд?ит[еа]?)(?![а-яёa-z0-9.-])|(?:^|\s)site:((?:[a-z0-9-]{1,63}\.){1,6}[a-z]{2,63})(?![a-z0-9.-])/g;
  let siteQuery = false;
  for (const match of text.matchAll(locations)) {
    siteQuery ||= Boolean(match[2]);
    const name = match[1] || match[2];
    const domain = /^(?:github|гит)/.test(name) && !name.includes('.') ? 'github.com'
      : /^(?:reddit|редд?ит)/.test(name) && !name.includes('.') ? 'reddit.com' : name.replace(/^www\./, '');
    if (domain.length <= 253 && domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
      && !domains.includes(domain)) domains.push(domain);
  }
  const web = /в (?:интернете|сети|вебе)|по интернету|\b(?:web|internet|online)\b/.test(text);
  const namedSite = /(?:на|с)\s+сайт[еа]\s+\S/.test(text);
  const explicitLocation = action && (web || domains.length > 0 || namedSite);
  const local = /(?:в|из|по)\s+(?:(?:этом|этой|этих|моем|моём|моей|приложенном|прикрепленном|локальной|локальном)\s+)?(?:коде|тексте|сообщении|документе|файле|папке|каталоге|диалоге|таблице|переписке)|на\s+(?:(?:моём|моем)\s+)?(?:диске|компьютере)/.test(text);
  if (local && /найди|найти|поищи|отыщи|ищи|find|search/.test(text) && !explicitLocation && !siteQuery) return empty;
  if (!explicitLocation && !siteQuery && !isVerificationRequest(text)) return empty;

  const wantsSources = /(?:найди|найти|нагугли|загугли|поищи|дай|покажи|пришли|find).{0,60}(?:ссылк|источник|links|sources)|(?:только|просто|лишь)\s+(?:список|ссылк|источник|результат)|\bonly\s+(?:links|sources|list)\b/.test(text);
  const wantsAnswer = /выбери|выбрать|сравни|сопостав|объясни|объяснить|разбери|проанализируй|оцени|почему|что лучше|\b(?:compare|explain|choose|analy[sz]e)\b/.test(text);
  const windows = [
    ['day', /за\s+сегодня|(?:последние|прошедшие)\s+(?:сутки|24\s+часа)|за\s+(?:последний\s+)?день|\bpast\s+(?:day|24\s+hours)\b/],
    ['week', /за\s+(?:(?:последнюю|прошедшую|эту)\s+)?неделю|(?:последние|последних)\s+7\s+дней|\bpast\s+(?:week|7\s+days)\b/],
    ['month', /за\s+(?:(?:последний|прошедший|этот)\s+)?месяц|(?:последние|последних)\s+30\s+дней|\bpast\s+(?:month|30\s+days)\b/],
    ['year', /за\s+(?:(?:последний|прошедший|этот)\s+)?год|(?:последние|последних)\s+365\s+дней|\bpast\s+(?:year|365\s+days)\b/],
  ].filter(([, pattern]) => pattern.test(text));
  return { explicitSearch: true, output: wantsSources && !wantsAnswer ? 'sources' : 'answer',
    requiredDomains: domains, requiredTimeRange: windows.length === 1 ? windows[0][0] : null };
}

function shouldSkipSearchForPrimarySource(message, hasPrimarySource) {
  if (!hasPrimarySource) return false;

  const text = String(message || '').toLowerCase();
  const explicitlyNeedsExternalData = searchRequestIntent(text).explicitSearch || [
    /(?:поищи|найди|проверь|сверь|дополни).{0,50}(?:в интернете|в сети|поиск|актуальн|сегодня|сейчас|новост|рынк)/,
    /(?:сравни|сопоставь).{0,50}(?:рынок|актуальн|интернет|сеть|сегодня|сейчас|новост)/,
    /(?:internet|web search|latest|current news|market data)/,
  ].some(pattern => pattern.test(text));

  return !explicitlyNeedsExternalData;
}

module.exports = {
  shouldSkipSearchForPrimarySource,
  isVerificationRequest,
  searchRequestIntent,
};

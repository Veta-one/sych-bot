function isVerificationRequest(message) {
  const text = String(message || '');
  if (/проверь.{0,40}(?:орфограф|граммат|пунктуац|арифметик|вычислен|расч[её]т|формул|код|тесты)/i.test(text)
    && !/интернет|в сети|первоисточник|правдив|актуальн|достовер/i.test(text)) return false;
  return /(?:проверь|перепроверь|проверить|правдив|достовер|фактчек|факт.?чек|это правда|правда ли|ты уверен|точно\?|откуда (?:ты )?(?:это|взял|инф)|подтверди|доказательств|первоисточник|нагугли|загугли|найди.{0,35}(?:ссылк|источник)|поищи|погугли|fact.?check|verify|are you sure)/i.test(text);
}

function shouldSkipSearchForPrimarySource(message, hasPrimarySource) {
  if (!hasPrimarySource) return false;

  const text = String(message || '').toLowerCase();
  const explicitlyNeedsExternalData = isVerificationRequest(text) || [
    /(?:поищи|найди|проверь|сверь|дополни).{0,50}(?:в интернете|в сети|поиск|актуальн|сегодня|сейчас|новост|рынк)/,
    /(?:сравни|сопоставь).{0,50}(?:рынок|актуальн|интернет|сеть|сегодня|сейчас|новост)/,
    /(?:internet|web search|latest|current news|market data)/,
  ].some(pattern => pattern.test(text));

  return !explicitlyNeedsExternalData;
}

module.exports = {
  shouldSkipSearchForPrimarySource,
  isVerificationRequest,
};

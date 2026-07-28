function normalizePrivacyCommand(text, triggerRegex) {
  const source = String(text || '').toLowerCase();
  if (!triggerRegex || !triggerRegex.test(source)) return '';

  return source
    .replace(triggerRegex, ' ')
    .replace(/[«»"'`.,!?;:()[\]{}—–_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isForgetMeRequest(text, triggerRegex) {
  const command = normalizePrivacyCommand(text, triggerRegex);
  if (!command) return false;

  return [
    /^забудь (?:все |всё )?(?:обо мне|про меня|меня)(?: пожалуйста)?$/,
    /^удали (?:все |всё )?(?:обо мне|про меня|мои данные|мою память)(?: пожалуйста)?$/,
    /^очисти (?:все |всё )?(?:обо мне|мои данные|мою память)(?: пожалуйста)?$/,
  ].some(pattern => pattern.test(command));
}

module.exports = {
  isForgetMeRequest,
  normalizePrivacyCommand,
};

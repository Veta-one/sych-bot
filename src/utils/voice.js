const VOICE_SUMMARY_THRESHOLD = 700;
const VOICE_SUMMARY_MAX_CHARS = 600;

function parseVoiceJson(raw) {
  return JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

function readTranscript(raw) {
  const result = parseVoiceJson(raw);
  if (typeof result?.text !== 'string' || !result.text.trim()) {
    throw new Error('Модель не вернула текст расшифровки');
  }
  return result.text.trim();
}

function shouldSummarizeVoice(text) {
  return text.trim().length > VOICE_SUMMARY_THRESHOLD;
}

function selectVoiceSummary(text, summary) {
  if (!shouldSummarizeVoice(text) || typeof summary !== 'string') return '';
  const trimmed = summary.trim();
  // Never truncate a summary: the cut could remove a condition or negation.
  if (!trimmed || trimmed.length > VOICE_SUMMARY_MAX_CHARS || trimmed.length > text.trim().length / 2) return '';
  return trimmed;
}

module.exports = { parseVoiceJson, readTranscript, shouldSummarizeVoice, selectVoiceSummary };

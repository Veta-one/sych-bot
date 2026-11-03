const fs = require('node:fs');
const { dirname } = require('node:path');
const { atomicWriteJsonSync } = require('./storage');

const API = 'https://openrouter.ai/api/v1';
const MODEL = 'google/gemma-3-27b-it';
const PROVIDER = 'deepinfra/fp8';
const USD = 1_000_000;
const RESERVE_MICROS = 50_000;
const MAX_OUTPUT_TOKENS = 2048;
const SEARCH_MICROS = 7000;
const UNAVAILABLE = 'PRIVATE_BUDGET_UNAVAILABLE';

function unavailable() {
  return Object.assign(new Error('Private chat budget unavailable'), { code: UNAVAILABLE });
}

function createPrivateBudget({ file, limitUsd, fetchImpl = globalThis.fetch }) {
  const limit = Math.round(limitUsd * USD);

  function read() {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || !Number.isSafeInteger(value.usedMicros)
      || value.usedMicros < 0 || typeof value.halted !== 'boolean') throw unavailable();
    return value;
  }

  function fits(state, count) {
    return Number.isSafeInteger(limit) && limit > 0 && !state.halted
      && Number.isSafeInteger(count) && count >= 0
      && count <= Math.floor((limit - state.usedMicros) / RESERVE_MICROS);
  }

  function canPurchase(replyCount = 100) {
    try {
      return fits(read(), replyCount);
    } catch {
      return false;
    }
  }

  async function complete({ apiKey, messages, search = false, floorReplies = () => 0 }) {
    if (!apiKey || !Array.isArray(messages) || messages.some(message => typeof message.content !== 'string')) {
      throw unavailable();
    }

    // Single bot process. Reserve before the first await and retain the full
    // amount if billing is ambiguous, including across crashes and restarts.
    try {
      const state = read();
      const floor = floorReplies();
      if (!Number.isSafeInteger(floor) || floor < 0 || !fits(state, floor + 1)) throw unavailable();
      atomicWriteJsonSync(file, { ...state, usedMicros: state.usedMicros + RESERVE_MICROS });
      if (process.platform === 'linux') {
        const fd = fs.openSync(dirname(file), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    } catch {
      throw unavailable();
    }

    const headers = {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'X-Title': 'Sych Bot Private Pilot',
      'X-OpenRouter-Metadata': 'enabled',
    };
    const response = await fetchImpl(API + '/chat/completions', {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(35_000),
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: MAX_OUTPUT_TOKENS,
        usage: { include: true },
        provider: {
          only: [PROVIDER],
          allow_fallbacks: false,
          require_parameters: true,
          // Full 131,072-token context at $0.20/M, 2,048 output at
          // $0.60/M, $0.001 per request and one $0.007 Exa search
          // fit under the $0.05 reservation, even with a margin.
          max_price: { prompt: 0.20, completion: 0.60, request: 0.001 },
        },
        plugins: [
          search ? { id: 'web', engine: 'exa', mode: 'auto', max_results: 3 } : { id: 'web', enabled: false },
          { id: 'file-parser', enabled: false },
          { id: 'response-healing', enabled: false },
          { id: 'context-compression', enabled: false },
        ],
      }),
    });
    if (!response.ok) throw new Error('Private model request failed');
    const result = await response.json();

    const usage = result.usage;
    const cost = usage?.cost;
    const route = result.openrouter_metadata;
    const byok = usage?.is_byok === true || route?.is_byok === true;
    const shared = usage?.is_byok === false || route?.is_byok === false;
    const charge = Number.isFinite(cost) && cost >= 0
      ? Math.ceil(cost * USD) + (search ? SEARCH_MICROS : 0) : null;
    // Account for the search fee separately even if the response's cost
    // already includes it. No optimistic release on incomplete accounting.
    if (byok || (result.model && result.model !== MODEL) || (charge !== null && charge > RESERVE_MICROS)) {
      const state = read();
      atomicWriteJsonSync(file, { ...state, halted: true });
      throw unavailable();
    }
    if (shared && charge !== null) {
      const state = read();
      atomicWriteJsonSync(file, { ...state, usedMicros: state.usedMicros - RESERVE_MICROS + charge });
    }

    const answer = result.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('Private model returned no answer');
    return answer.trim();
  }

  return { canPurchase, complete };
}

module.exports = { createPrivateBudget, PRIVATE_BUDGET_UNAVAILABLE: UNAVAILABLE };

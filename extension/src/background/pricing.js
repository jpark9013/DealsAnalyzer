import { MODELS } from './settings.js';

// USD per search, billed on top of tokens.
export const WEB_SEARCH_PRICE = 0.01;

/**
 * Estimated cost of one analysis. Each continuation request re-sends the
 * whole conversation, so every request's usage is billed in full.
 * @param {object[]} usages  `usage` objects from each Messages API response
 */
export function estimateCost(usages, model) {
  const pricing = MODELS[model]?.pricing;
  const totals = { inputTokens: 0, outputTokens: 0, webSearches: 0, requests: usages.length, costUsd: null };
  let cost = 0;

  for (const u of usages) {
    const prompt =
      (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const output = u.output_tokens || 0;
    const searches = u.server_tool_use?.web_search_requests || 0;
    totals.inputTokens += prompt;
    totals.outputTokens += output;
    totals.webSearches += searches;

    if (pricing) {
      const long = pricing.longThreshold && prompt > pricing.longThreshold;
      const inRate = long ? pricing.longInput : pricing.input;
      const outRate = long ? pricing.longOutput : pricing.output;
      cost += (prompt * inRate + output * outRate) / 1_000_000 + searches * WEB_SEARCH_PRICE;
    }
  }

  if (pricing) totals.costUsd = Math.round(cost * 10_000) / 10_000;
  return totals;
}

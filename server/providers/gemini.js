import { createGeminiTokenHandler } from './gemini/realtime.js';
import { handleGeminiAgentPlan } from './gemini/agent-plan.js';
import { sameSiteGated } from './common/same-site.js';

/** Mint constrained Live API credentials; the permanent key stays on Node. */
function geminiLiveProxy({ annotationGuidance, realtime = {} } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/gemini/token',
      createGeminiTokenHandler({ ...realtime, annotationGuidance }),
    );
    // Sentinel planning relay on Gemini (operator pivoted off the OpenAI
    // relay): same keyless-503 degradation, same-origin gated like every
    // cost-bearing proxy.
    middlewares.use('/api/gemini/agent-plan', sameSiteGated(handleGeminiAgentPlan));
  }
  return {
    name: 'gemini-live-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { geminiLiveProxy };

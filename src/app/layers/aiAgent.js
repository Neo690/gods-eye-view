import { createAiAgentLayer } from '../../layers/aiAgent/index.js';
import { overlayHost } from './overlayHost.js';

export function createApplicationAiAgent(options = {}) {
  return createAiAgentLayer({ overlayHost, ...options });
}

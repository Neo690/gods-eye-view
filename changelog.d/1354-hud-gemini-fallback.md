- The HUD's five-word summary survives an exhausted OpenAI key. When
  `/v1/responses` refuses or returns no text, the route retries the same
  provenance-bound instructions on Gemini 3.1 Flash Lite with the server-held
  `GEMINI_API_KEY`, keeping the key in a request header and keeping the fixed
  error shape when both providers fail. A phone whose OpenAI credit balance is
  spent now gets a live summary instead of the fallback line (Neo690, #1354).

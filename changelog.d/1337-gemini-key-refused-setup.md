- Diagnose a refused Gemini key at setup instead of blaming the model.
  Google answers an invalid credential with 400 `API_KEY_INVALID` / "API key
  not valid", not with 401/403 — so the Gemini token mint reads the capped
  upstream refusal body for that marker only and answers the failure as the
  Provider-Settings fix it is: "The Gemini API key was refused. Check it in
  Provider Settings." — never as an unavailable model. Nothing from an
  upstream answer, not even an answer that embeds the key, is ever forwarded
  or logged, and `geminiServer.test.mjs` pins both the classification and the
  generic answer for every other 400 (yourname, #1337).

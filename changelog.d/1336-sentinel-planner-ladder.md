- Word the Sentinel's warning findings through two server-side relays, tried
  in order, with the credential always server-side. The question rides the
  cheap planner: OpenAI first on `/api/openai/agent-plan` (`gpt-5-nano`
  default, `OPENAI_AGENT_PLAN_MODEL` overrides — low reasoning effort, a
  700-token budget), answering the same small JSON envelope
  (`{instructions, input}` in, `{plan}` out) over the already-compressed
  layer view; when that relay cannot answer, the identical request goes to
  `/api/gemini/agent-plan` — one `generateContent` round-trip on
  `gemini-2.5-flash` (`GEMINI_AGENT_PLAN_MODEL` overrides), riding the same
  per-IP budget as the Gemini voice mint. A keyless relay answers a clean
  `503 not-configured`, so the fallback happens quietly and either the
  OpenAI **or** the Gemini key alone words findings; a throttled relay
  (`429`) ends the cycle instead of falling through, because repaying the
  same packet to the second provider would turn one throttle into a double
  spend (yourname, #1336).

import { defineAgent } from "eve";
import { minimax } from "vercel-minimax-ai-provider";

// Use the direct MiniMax provider (not AI Gateway).
// Talks to https://api.minimax.io/anthropic/v1 using the Anthropic Messages format.
//
// Why not the Gateway string "minimax/minimax-m3"? Direct provider:
//   - skips AI Gateway metering/cache/cooldown rules
//   - lets us pick the regional endpoint via MINIMAX_API_BASE_URL
//   - reads credentials from MINIMAX_API_KEY (no OIDC dance)
//
// M3 is the first MiniMax model to bundle:
//   - 1M-token context window (MSA sparse attention)
//   - native multimodal input (image + video)
//   - frontier coding / agentic performance
//
// Note: this provider package (v0.0.2) was published before M3 was released,
// so M3 isn't in its typed enum yet — but the type signature is `string`-fallback,
// meaning any model id passes through. If MiniMax's Anthropic-compat endpoint
// accepts "MiniMax-M3", this works. If it 404s, fall back to "MiniMax-M2.7".
export default defineAgent({
  model: minimax("MiniMax-M3"),
});

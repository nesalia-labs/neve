import { defineMcpClientConnection } from "eve/connections";

// Exa MCP — current web search, deep research, code context, company research.
// Connection name `exa` (path-derived) exposes tools as `exa__<tool>` to the model.
export default defineMcpClientConnection({
  url: "https://mcp.exa.ai/mcp",
  description:
    "Exa web search: current web results, deep research, code context, and company research. " +
    "Use when the user needs information from the public web that may be newer than the model's training data, " +
    "or when grounding claims in primary sources (news, docs, blog posts, papers).",
  auth: {
    getToken: async () => ({ token: process.env.EXA_API_KEY! }),
  },
});
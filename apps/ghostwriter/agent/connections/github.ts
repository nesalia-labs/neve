import { defineMcpClientConnection } from "eve/connections";

// GitHub MCP — repos, code search, issues, pull requests, file contents.
// Connection name `github` (path-derived) exposes tools as `github__<tool>` to the model.
//
// URL: Microsoft's official GitHub MCP server. If this endpoint is not reachable
// from your deployment, swap to a self-hosted variant (e.g. the docker image from
// github/github-mcp-server) or an OpenAPI connection over the GitHub REST API.
export default defineMcpClientConnection({
  url: "https://api.githubcopilot.com/mcp/",
  description:
    "GitHub: search and read repositories, source files, issues, pull requests, and discussions. " +
    "Use when the user references a specific repo, needs to read or quote source code, " +
    "or wants to ground claims in PR/issue/commit content. Prefer this over `web_fetch` for github.com URLs.",
  auth: {
    getToken: async () => ({ token: process.env.GITHUB_TOKEN! }),
  },
  // Tighten further with `tools: { allow: [...] }` once you know which tools the model actually uses.
});
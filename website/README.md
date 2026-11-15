# Website + TalkToFigma MCP

Static site scaffold for Emory Hacks Pose Studio, with Cursor MCP config for [TalkToFigma](https://github.com/grab/cursor-talk-to-figma-mcp).

## MCP config

Project MCP lives at:

- `.cursor/mcp.json` (Cursor)
- `.mcp.json` (Claude Code / compatible clients)

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bunx",
      "args": [
        "cursor-talk-to-figma-mcp@latest"
      ]
    }
  }
}
```

## Prerequisites

1. Install [Bun](https://bun.sh).
2. Open this `website/` folder (or the repo) in Cursor so the project MCP config loads.
3. Start the TalkToFigma WebSocket relay per the package docs (`bun socket` when running from a local checkout of the MCP repo).
4. In Figma, run the Cursor MCP plugin and join the same channel.
5. In Cursor, call `join_channel` before other Figma tools.

## Preview the site

```bash
cd website
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8000`.

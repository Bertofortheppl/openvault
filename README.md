# OpenVault

Chat with [opencode](https://opencode.ai) from your Obsidian sidebar.

OpenVault is an Obsidian plugin that embeds an opencode AI collaborator directly in the sidebar. Type a message, get a streamed response -- with full awareness of your vault context.

## How It Works

```
Obsidian Plugin (TypeScript/Obsidian API)
  -> HTTP client to opencode serve
  -> Obsidian vault as working directory
  -> Sidebar chat view with streaming responses
```

OpenVault connects to `opencode serve` running on your machine. It does not spawn or manage the server process -- you run opencode in a terminal, and the plugin auto-connects via health checks every 10 seconds.

## Requirements

- [Obsidian](https://obsidian.md) v1.5.0+
- [opencode](https://opencode.ai) installed and available
- An API key for your LLM provider (e.g., OpenRouter, Anthropic)

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Copy them to `.obsidian/plugins/openvault/` in your vault
3. Enable **OpenVault** in Obsidian Settings > Community Plugins

## Usage

1. Open a terminal and start the opencode server:

```bash
cd /path/to/your/vault
opencode serve --port 4097
```

2. In Obsidian, click the message-square ribbon icon, or run the command "Open OpenVault chat"
3. The plugin auto-connects within 10 seconds -- the status indicator turns green
4. Type your message and press Enter or click Send

To stop the server, press Ctrl+C in the terminal.

## Configuration

OpenVault settings are available under the plugin settings tab in Obsidian:

| Setting | Description |
|---------|-------------|
| Server port | Port the opencode server is running on (default: 4097) |
| OpenRouter API key | API key used by opencode for authentication |

## Build from Source

```bash
git clone https://github.com/Bertofortheppl/openvault
cd openvault
npm install
node esbuild.config.mjs
cp main.js /path/to/.obsidian/plugins/openvault/main.js
```

## Architecture

OpenVault uses the opencode HTTP API (`opencode serve`) for all communication:

- `POST /session` -- create a new chat session
- `POST /session/:id/prompt_async` -- send a message (non-blocking, returns 204)
- `GET /global/event` -- SSE stream for deltas and session lifecycle events
- `GET /global/health` -- server health check (polled every 10s)

The plugin uses Node's `http` module directly (not browser `fetch`) to avoid sandbox restrictions when Obsidian runs as a Flatpak.

## License

MIT

# OpenVault

Chat with [opencode](https://opencode.ai) from your Obsidian sidebar.

OpenVault puts an opencode session in your vault. It starts its own local server, uses your vault as the working directory, and streams replies into a sidebar chat. Your notes, folders, and `AGENTS.md` are already in context.

## Requirements

- [Obsidian](https://obsidian.md) 1.5.0 or newer (desktop only)
- [opencode](https://opencode.ai) installed and authenticated (`opencode auth login`)
- A model and provider configured in opencode

## Install

OpenVault is not in the community plugin store yet. Releases ship the three files you need (`main.js`, `manifest.json`, `styles.css`). If there is no release yet, build from source below.

1. Download those files from the latest release.
2. Put them in `<your-vault>/.obsidian/plugins/openvault/`.
3. Enable **OpenVault** in Settings > Community plugins.

## Use

Click the message-square ribbon icon, or run **Open OpenVault chat** from the command palette.

The plugin starts its own `opencode serve` on a free local port. The zap icon in the chat header shows the connection state; click it to reconnect.

- **Enter** sends, **Shift+Enter** starts a new line.
- Type **`/`** to pick a skill.
- The **build/plan** badge switches agents.
- **+** starts a new conversation.
- Permission requests show up as inline cards: Allow once, Always, or Reject.
- When opencode asks a clarifying question, you answer it in the chat instead of losing the turn.

## Settings

| Setting | What it does |
|---|---|
| opencode binary | Path to the binary. Leave empty to auto-detect (`~/.opencode/bin/opencode`). |
| Auto-start server | Starts the managed server when the vault loads. On by default. |
| Inject note context | Sends the active note path and any selected text with each prompt. |

Credentials come from `opencode auth`, not the plugin. OpenVault inherits your opencode permission config, so your existing allow/ask/deny rules still apply.

## How It Works

```
Obsidian (TypeScript)
  -> spawns opencode serve on an ephemeral port
  -> official @opencode-ai/sdk (v2 API)
  -> SSE events for text, tools, permissions, questions
  -> vault root as the server working directory
```

Only the session ID is stored. Message history lives in opencode and is fetched when the view opens.

## Troubleshooting

- **Server won't start**: check the opencode path in settings. The default is `~/.opencode/bin/opencode`.
- **Model or credential errors**: they show up as an error bubble. Check `~/.local/share/opencode/log/opencode.log` for details.
- **Flatpak**: spawned processes read config from `~/.var/app/md.obsidian.Obsidian/`. If opencode config isn't found there, make `~/.var/app/md.obsidian.Obsidian/config/opencode/opencode.jsonc` a symlink pointing at `~/.config/opencode/opencode.jsonc`.
- **Reconnect**: click the zap icon in the chat header, or run **OpenVault: reconnect**.

## Build From Source

```bash
git clone https://github.com/Bertofortheppl/openvault
cd openvault
npm install
npm run build:prod
cp main.js styles.css manifest.json <your-vault>/.obsidian/plugins/openvault/
```

Then toggle OpenVault off and on in Obsidian.

## License

MIT. See [LICENSE](LICENSE).

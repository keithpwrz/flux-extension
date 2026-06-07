# Flux — Roblox Server Finder

Browser extension that finds Roblox servers by region. See real player counts, pings, and join the best server instantly.

## Features

- One-click server scanning on any Roblox game page
- Region detection with 16 datacenter locations worldwide
- Player avatars, ping ratings, and player counts per server
- Direct join — launches Roblox into the exact server you pick
- Works on Chrome, Edge, Brave, and Firefox

## Install (Chrome / Edge / Brave)

1. Download or clone this repo
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode** (toggle top-right)
4. Click **Load unpacked**
5. Select the `flux-extension` folder
6. Open any Roblox game page — the Flux button appears beside the Play button

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.firefox.json` (rename to `manifest.json` first, or load directly)
4. Open any Roblox game page

## How It Works

Flux fetches the public server list from Roblox's API, resolves each server's IP to a geographic region, and shows you which servers are available near you. You pick a server, Flux launches Roblox directly into it.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save your preferences |
| `scripting` | Inject the Flux panel on Roblox pages |
| `declarativeNetRequest` | Spoof User-Agent for gamejoin requests |
| `*.roblox.com` | Fetch server lists and join games |
| `cookies` | Use your Roblox session for authenticated requests |

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for architecture and file roles.

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). Flux does not collect, store, or send your data anywhere.

## License

MIT

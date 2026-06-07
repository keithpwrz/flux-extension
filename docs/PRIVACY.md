# Flux — Privacy

## What Flux Accesses

Flux runs on Roblox game pages (`www.roblox.com` and `web.roblox.com`). It:

- Reads the current page URL to extract the game's place ID
- Fetches public server lists from `games.roblox.com` using your browser's Roblox session
- Fetches player avatar thumbnails from `thumbnails.roblox.com`
- Resolves server IPs via `gamejoin.roblox.com` to determine geographic region
- Launches Roblox games via `roblox://` protocol links

## What Flux Does NOT Do

- Does **not** collect, store, or transmit your personal data
- Does **not** read or access your Roblox cookies, passwords, or account details
- Does **not** send data to any third-party server
- Does **not** use analytics, tracking, or telemetry
- Does **not** modify any page content except adding the Flux server finder UI

## Network Requests

All network requests are made directly from your browser to Roblox's APIs. No data passes through any intermediary server.

The extension does not include or communicate with any external backend.

## Permissions Explained

| Permission | Used For |
|---|---|
| `storage` | Caching the IP-to-region database locally (refreshed every 24 hours) |
| `scripting` | Injecting the Flux UI onto Roblox game pages |
| `declarativeNetRequest` | Setting a User-Agent header required by Roblox's gamejoin API |
| Host: `*.roblox.com` | Fetching server lists, thumbnails, and game join tokens |
| `cookies` | Your Roblox session is used automatically by the browser for authenticated API calls |

## Open Source

This extension is open source. You can inspect every line of code in this repository to verify these claims.

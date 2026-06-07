# Flux Extension — Development Guide

## File Roles

| File | Purpose |
|---|---|
| `manifest.json` | Chrome MV3 manifest — permissions, content scripts, background worker |
| `manifest.firefox.json` | Firefox variant — uses `scripts` background instead of `service_worker` |
| `content.js` | Injected into Roblox game pages. Builds the Flux dashboard UI, fetches server lists, resolves IPs to regions, handles game joining |
| `background.js` | Service worker. Routes messages from content script, handles game launch via `Roblox.GameLauncher` |
| `styles.css` | All Flux UI styling — injected alongside content script |
| `popup.html` / `popup.js` | Extension toolbar popup for settings |
| `json/rules.json` | `declarativeNetRequest` rules — spoofs User-Agent for gamejoin.roblox.com |
| `icons/` | Extension icons (16px, 48px, 128px) |

## How It Works

### Injection (content.js)

1. `onDOM()` waits for `document.body`, then calls `init()` after 800ms
2. `init()` injects the Flux play button beside Roblox's Play button (70/30 split, RoRegion-style)
3. A MutationObserver watches for SPA navigation (Roblox uses client-side routing) and re-injects on page change
4. A container guard (`pruneContainerChildren` + `attachContainerGuard`) prevents Roblox from removing our button

### Server Fetching

1. `doFetch()` → `processAllServers(placeId)` fetches up to 5 pages (500 servers) from `games.roblox.com/v1/games/{id}/servers/Public`
2. Each server's IP is resolved via `gamejoin.roblox.com/v1/join-game-instance` (POST, requires CSRF token)
3. IP → region matching uses a CIDR table (loaded from local storage, refreshed every 24h)

### Region Detection

- The CIDR table maps server IPs to geographic regions
- 16 datacenter locations supported: Frankfurt, Paris, Amsterdam, London, Singapore, Tokyo, Mumbai, LA, Ashburn, Chicago, Dallas, Miami, NYC, Seattle, Sydney, São Paulo
- Unmatched IPs fall through to "Unknown" — shown in the sidebar as pending

### Game Joining

- User clicks "Join" on a server card → `background.js` receives `flux.launchGame` message
- Background opens `roblox://` protocol link with the specific `gameInstanceId`

## Known Limitations

- CSRF token is obtained via `auth.roblox.com/v2/logout` — requires an active Roblox session
- `gamejoin.roblox.com` blocks browser User-Agents — requires the `declarativeNetRequest` rule to spoof `Roblox/WinInet`
- Rate limits apply to both the servers API and gamejoin API — handled with exponential backoff

## Loading for Development

### Chrome
1. Go to `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" → select the `flux-extension` folder
4. After changes, click the reload icon on the extension card

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" → select `manifest.firefox.json`
3. Firefox auto-reloads on file changes

## Testing

1. Open any Roblox game page (e.g. `https://www.roblox.com/games/2753915549/Brookhaven`)
2. The green Flux play button appears beside the Roblox Play button
3. Click it → the Flux dashboard opens
4. Click a region in the sidebar → server cards appear
5. Click "Join" on any card → Roblox launches into that server

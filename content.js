// Flux — RoRegion-style server finder injected into Roblox game pages
(function() {
  console.log('[Flux] content script loaded v0.0.6');
  // ═══════════════════════════════════════════════════════════════
  // XHR INTERCEPTION — BetterBlox-style hook
  // Captures CSRF tokens + caches server list responses from Roblox
  // ═══════════════════════════════════════════════════════════════
  (function() {
    var OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
      var xhr = new OrigXHR();
      var origOpen = xhr.open;
      var origSend = xhr.send;

      xhr.open = function(method, url) {
        xhr._fluxUrl = url;
        return origOpen.apply(xhr, arguments);
      };

      xhr.send = function(body) {
        xhr.addEventListener('load', function() {
          try {
            // Capture CSRF token from ANY Roblox API response
            var csrf = xhr.getResponseHeader('x-csrf-token');
            if (csrf) {
              window.__fluxCsrfToken = csrf;
            }

            // Cache server list responses from games.roblox.com
            var url = xhr._fluxUrl;
            if (url && url.indexOf('games.roblox.com/v1/games/') !== -1 && url.indexOf('/servers/') !== -1) {
              var ct = xhr.getResponseHeader('content-type');
              if (ct && ct.indexOf('application/json') !== -1) {
                var data = JSON.parse(xhr.responseText);
                if (data.data && data.data.length) {
                  window.__fluxXhrServerCache = window.__fluxXhrServerCache || {};
                  window.__fluxXhrServerCache[url] = {
                    data: data,
                    timestamp: Date.now()
                  };
                }
              }
            }
          } catch(e) { /* silent */ }
        });
        return origSend.apply(xhr, arguments);
      };

      return xhr;
    };
  })();

  // ═══════════════════════════════════════════════════════════════

  var lastGood = [];        // last successful unfiltered server list
  var filtered = [];        // currently sorted/filtered display list
  var refreshing = false;
  var failedRefresh = false;
  var lastFetch = null;
  var autoTimer = null;
  var activeSort = "ping-lowest";   // default: RoRegion-style — best ping first
  var toggleReady = false;
  var currentUrl = location.href;
  var selectedRegion = null;   // currently selected region key in sidebar
  var BATCH_SIZE = 20;
  var visibleServerCount = 0;

  // ── Region display mapping ──────────────────────────────────────────
  // Maps Roblox region strings → display name and continent group.
  // Exact 16 regions from RoRegion source (defaultRegions array).
  // Source: RoRegion regionSelector.js line 2215

  var REGION_MAP = {
    // Europe (RoRegion: DE, FR, NL, GB)
    "frankfurt, de":            { name: "Frankfurt, Germany",         group: "EUROPE",      code: "DE" },
    "paris, fr":                { name: "Paris, France",              group: "EUROPE",      code: "FR" },
    "amsterdam, nl":            { name: "Amsterdam, Netherlands",     group: "EUROPE",      code: "NL" },
    "london, uk":               { name: "London, UK",                 group: "EUROPE",      code: "GB" },
    // Asia (RoRegion: SG, JP, IN)
    "singapore, sg":            { name: "Singapore",                  group: "ASIA",        code: "SG" },
    "tokyo, jp":                { name: "Tokyo, Japan",               group: "ASIA",        code: "JP" },
    "mumbai, in":               { name: "Mumbai, India",              group: "ASIA",        code: "IN" },
    // North America (RoRegion: US-CA, US-VA, US-IL, US-TX, US-FL, US-NY, US-WA)
    "los angeles, ca":          { name: "LA, California, USA",        group: "NORTH AMERICA", code: "US-CA" },
    "ashburn, va":              { name: "Ashburn, Virginia, USA",     group: "NORTH AMERICA", code: "US-VA" },
    "chicago, il":              { name: "Chicago, Illinois, USA",     group: "NORTH AMERICA", code: "US-IL" },
    "dallas, tx":               { name: "Dallas, Texas, USA",         group: "NORTH AMERICA", code: "US-TX" },
    "miami, fl":                { name: "Miami, Florida, USA",        group: "NORTH AMERICA", code: "US-FL" },
    "new york city, ny":        { name: "New York City, New York, USA", group: "NORTH AMERICA", code: "US-NY" },
    "seattle, wa":              { name: "Seattle, Washington, USA",   group: "NORTH AMERICA", code: "US-WA" },
    // Oceania (RoRegion: AU)
    "sydney, au":               { name: "Sydney, Australia",          group: "OCEANIA",     code: "AU" },
    // South America (RoRegion: BR)
    "são paulo, br":            { name: "São Paulo, Brazil",          group: "SOUTH AMERICA", code: "BR" },
  };

  // Reverse map: RoRegion region code → REGION_MAP key (for CIDR table lookup)
  var RR_CODE_TO_KEY = {};
  for (var _rmk in REGION_MAP) {
    if (REGION_MAP[_rmk].code) RR_CODE_TO_KEY[REGION_MAP[_rmk].code] = _rmk;
  }

  function getRegionInfo(raw) {
    if (!raw || raw === "Pending" || raw === "Unknown") {
      return { name: raw || "Pending", group: "PENDING", code: null };
    }
    var r = raw.toLowerCase().trim();

    // Exact match
    if (REGION_MAP[r]) return REGION_MAP[r];

    // Match by city name
    var cityPart = r.split(",")[0].trim();
    for (var key in REGION_MAP) {
      var keyCity = key.split(",")[0].trim();
      if (cityPart === keyCity) return REGION_MAP[key];
      if (r.indexOf(key.split(",")[0]) !== -1 || key.indexOf(cityPart) !== -1) {
        return REGION_MAP[key];
      }
    }

    return { name: raw, group: "OTHER", code: null };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  function pid() { var m = location.pathname.match(/\/games\/(\d+)/); return m ? m[1] : ""; }
  function isGamePage() { return /\/games\/\d+/.test(location.pathname); }
  function isReal(s) { return s && s.region && s.region !== "Pending" && s.region !== "Unknown"; }
  function timeAgo(d) { if (!d) return "never"; var s = Math.floor((Date.now()-d)/1000); if (s<60) return s+"s ago"; if (s<3600) return Math.floor(s/60)+"m ago"; return Math.floor(s/3600)+"h ago"; }
  function delay(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

  // ── Flag images (flagcdn.com — same as RoRegion) ────────────────────

  function getRegionFlag(code) {
    var map = {
      'SG':'sg','DE':'de','FR':'fr','JP':'jp','BR':'br','NL':'nl',
      'AU':'au','GB':'gb','IN':'in',
      'US-CA':'us','US-VA':'us','US-IL':'us','US-TX':'us',
      'US-FL':'us','US-NY':'us','US-WA':'us','US-GA':'us'
    };
    var cc = map[code];
    if (!cc) return null;
    return 'https://flagcdn.com/20x15/' + cc + '.png';
  }

  // Map region display name → country code for flagcdn.com
  var REGION_FLAG_CODES = {
    "Frankfurt, Germany": "DE", "Paris, France": "FR", "Tokyo, Japan": "JP",
    "São Paulo, Brazil": "BR", "Amsterdam, Netherlands": "NL",
    "Sydney, Australia": "AU", "London, UK": "GB", "Mumbai, India": "IN",
    "Singapore": "SG",
    "LA, California, USA": "US", "Ashburn, Virginia, USA": "US",
    "Chicago, Illinois, USA": "US", "Dallas, Texas, USA": "US",
    "Miami, Florida, USA": "US", "New York City, New York, USA": "US",
    "Seattle, Washington, USA": "US"
  };

  function getFlagUrl(displayName) {
    var code = REGION_FLAG_CODES[displayName];
    if (!code) return null;
    return 'https://flagcdn.com/20x15/' + code.toLowerCase() + '.png';
  }

  // ── Thumbnail fetching (RoRegion-style — batch API) ─────────────────

  var _thumbnailCache = {};

  async function fetchThumbnails(tokens) {
    if (!tokens || !tokens.length) return {};
    var uncached = [];
    for (var i = 0; i < tokens.length; i++) {
      if (!_thumbnailCache[tokens[i]]) uncached.push(tokens[i]);
    }
    if (!uncached.length) {
      var result = {};
      for (var j = 0; j < tokens.length; j++) { result[tokens[j]] = _thumbnailCache[tokens[j]]; }
      return result;
    }

    var requests = [];
    for (var k = 0; k < uncached.length; k++) {
      requests.push({
        requestId: uncached[k] + "::AvatarHeadshot:48x48:webp:regular",
        type: "AvatarHeadShot",
        targetId: 0,
        token: uncached[k],
        format: "webp",
        size: "48x48"
      });
    }

    try {
      var resp = await fetch("https://thumbnails.roblox.com/v1/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(requests),
        credentials: "omit"
      });
      if (resp.ok) {
        var data = await resp.json();
        (data.data || []).forEach(function(d) {
          var token = (d.requestId || "").split("::")[0];
          if (token) _thumbnailCache[token] = (d.state === "Completed" && d.imageUrl) ? d.imageUrl : null;
        });
      }
      // RoRegion pattern: 250ms delay between batches to avoid rate limits
      await delay(250);
    } catch (e) { /* silent */ }

    var out = {};
    for (var m = 0; m < tokens.length; m++) { out[tokens[m]] = _thumbnailCache[tokens[m]] || null; }
    return out;
  }

  // ── Direct Roblox API (extension-only — no Python backend) ────────────

  var _csrfToken = null;
  var _serverCache = {};       // serverId → resolved region data
  var _activeResolve = false;  // prevent duplicate resolution runs
  var _CONCURRENT = 4;         // concurrent gamejoin calls (BetterBlox uses 4)
  var _rateLimitPause = false;  // global flag — pauses all workers on 429

  // ── RoRegion CIDR table (loaded from GitHub, cached in storage) ──────
  var _rrIpTable = null;    // IP /24 → {co, ci, r, la, lo}
  var _rrCountries = [];    // [[name, code], ...]
  var _rrRegions = [];      // [state_code, ...]
  var _rrCities = [];       // [city_name, ...]

  async function loadRRIpTable() {
    var RR_URL = "https://raw.githubusercontent.com/RoRegion/Storage/refs/heads/main/regionList.json";
    var CACHE_KEY = "flux_rr_ip_table";
    var CACHE_TIME_KEY = "flux_rr_ip_table_time";
    var TTL = 86400000; // 24 hours

    // Try cache first
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        var cached = await new Promise(function(resolve) {
          chrome.storage.local.get([CACHE_KEY, CACHE_TIME_KEY], function(r) { resolve(r); });
        });
        if (cached[CACHE_KEY] && cached[CACHE_TIME_KEY] && (Date.now() - cached[CACHE_TIME_KEY] < TTL)) {
          var ct = cached[CACHE_KEY];
          _rrIpTable = ct.ip;
          _rrCountries = ct.co;
          _rrRegions = ct.r;
          _rrCities = ct.ci;
          return;
        }
      }
    } catch (e) { /* proceed to fetch */ }

    // Fetch from GitHub
    try {
      var resp = await fetch(RR_URL, { cache: "no-cache" });
      if (!resp.ok) return;
      var raw = await resp.json();
      _rrCountries = raw._c || [];
      _rrRegions = raw._r || [];
      _rrCities = raw._ci || [];
      _rrIpTable = {};
      for (var key in raw) {
        if (key[0] === "_") continue;
        _rrIpTable[key] = raw[key];
      }

      // Cache to storage
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({
            [CACHE_KEY]: { ip: _rrIpTable, co: _rrCountries, r: _rrRegions, ci: _rrCities },
            [CACHE_TIME_KEY]: Date.now()
          });
        }
      } catch (e2) { /* silent */ }
    } catch (e3) { /* silent */ }
  }

  function resetCsrf() { _csrfToken = null; }

  async function getCsrfToken() {
    if (_csrfToken) return _csrfToken;
    // Try XHR-intercepted token first (zero-cost — no API call)
    if (window.__fluxCsrfToken) {
      _csrfToken = window.__fluxCsrfToken;
      return _csrfToken;
    }
    try {
      var res = await fetch("https://auth.roblox.com/v2/logout", {
        method: "POST", credentials: "include"
      });
      _csrfToken = res.headers.get("x-csrf-token");
      if (_csrfToken) { window.__fluxCsrfToken = _csrfToken; return _csrfToken; }
    } catch (e) { /* continue to fallback */ }

    // RoRegion fallback: read from page <meta> tag
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) {
      _csrfToken = meta.content;
      window.__fluxCsrfToken = _csrfToken;
      return _csrfToken;
    }
    return null;
  }

  // CIDR-based IP → region matching (same data as Python backend)
  var IP_REGIONS = [
    { prefix: "128.116.115",   flag: "🇺🇸", city: "Seattle, WA",       country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.116",   flag: "🇺🇸", city: "Los Angeles, CA",   country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.1",     flag: "🇺🇸", city: "Los Angeles, CA",   country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.63",    flag: "🇺🇸", city: "Los Angeles, CA",   country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.117",   flag: "🇺🇸", city: "los angeles, ca",   country: "US", group: "NORTH AMERICA" },
    { prefix: "209.206.42",    flag: "🇺🇸", city: "los angeles, ca",   country: "US", group: "NORTH AMERICA" },
    { prefix: "209.206.43",    flag: "🇺🇸", city: "los angeles, ca",   country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.95",    flag: "🇺🇸", city: "Dallas, TX",        country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.101",   flag: "🇺🇸", city: "Chicago, IL",       country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.48",    flag: "🇺🇸", city: "Chicago, IL",       country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.22",    flag: "🇺🇸", city: "miami, fl",         country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.99",    flag: "🇺🇸", city: "miami, fl",         country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.45",    flag: "🇺🇸", city: "Miami, FL",         country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.127",   flag: "🇺🇸", city: "Miami, FL",         country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.102",   flag: "🇺🇸", city: "Ashburn, VA",       country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.53",    flag: "🇺🇸", city: "Ashburn, VA",       country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.32",    flag: "🇺🇸", city: "New York City, NY", country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.54",    flag: "🇺🇸", city: "seattle, wa",       country: "US", group: "NORTH AMERICA" },
    { prefix: "128.116.33",    flag: "🇬🇧", city: "London, UK",        country: "GB", group: "EUROPE" },
    { prefix: "128.116.119",   flag: "🇬🇧", city: "London, UK",        country: "GB", group: "EUROPE" },
    { prefix: "128.116.21",    flag: "🇳🇱", city: "Amsterdam, NL",     country: "NL", group: "EUROPE" },
    { prefix: "128.116.4",     flag: "🇫🇷", city: "Paris, FR",         country: "FR", group: "EUROPE" },
    { prefix: "128.116.122",   flag: "🇫🇷", city: "Paris, FR",         country: "FR", group: "EUROPE" },
    { prefix: "128.116.5",     flag: "🇩🇪", city: "Frankfurt, DE",     country: "DE", group: "EUROPE" },
    { prefix: "128.116.44",    flag: "🇩🇪", city: "Frankfurt, DE",     country: "DE", group: "EUROPE" },
    { prefix: "128.116.123",   flag: "🇩🇪", city: "Frankfurt, DE",     country: "DE", group: "EUROPE" },
    { prefix: "128.116.31",    flag: "🇩🇪", city: "frankfurt, de",     country: "DE", group: "EUROPE" },
    { prefix: "128.116.124",   flag: "🇩🇪", city: "frankfurt, de",     country: "DE", group: "EUROPE" },
    { prefix: "128.116.104",   flag: "🇮🇳", city: "Mumbai, IN",        country: "IN", group: "ASIA" },
    { prefix: "128.116.47",    flag: "🇮🇳", city: "Mumbai, IN",        country: "IN", group: "ASIA" },
    { prefix: "128.116.55",    flag: "🇯🇵", city: "Tokyo, JP",         country: "JP", group: "ASIA" },
    { prefix: "128.116.120",   flag: "🇯🇵", city: "Tokyo, JP",         country: "JP", group: "ASIA" },
    { prefix: "128.116.50",    flag: "🇸🇬", city: "Singapore, SG",     country: "SG", group: "ASIA" },
    { prefix: "128.116.46",    flag: "🇸🇬", city: "Singapore, SG",     country: "SG", group: "ASIA" },
    { prefix: "128.116.97",    flag: "🇸🇬", city: "Singapore, SG",     country: "SG", group: "ASIA" },
    { prefix: "128.116.30",    flag: "🇸🇬", city: "singapore, sg",     country: "SG", group: "ASIA" },
    { prefix: "128.116.118",   flag: "🇸🇬", city: "singapore, sg",     country: "SG", group: "ASIA" },
    { prefix: "128.116.51",    flag: "🇦🇺", city: "Sydney, AU",        country: "AU", group: "OCEANIA" },
    { prefix: "128.116.13",    flag: "🇳🇱", city: "Amsterdam, NL",     country: "NL", group: "EUROPE" },
    { prefix: "128.116.86",    flag: "🇧🇷", city: "são paulo, br",     country: "BR", group: "SOUTH AMERICA" },
  ];

  function matchIPToRegion(ip) {
    if (!ip || ip.indexOf("10.") === 0 || ip.indexOf("127.") === 0 || ip === "0.0.0.0") return null;

    // Primary: RoRegion CIDR table (loaded from GitHub, comprehensive /24 coverage)
    if (_rrIpTable) {
      var ip24 = ip.split(".").slice(0, 3).join(".") + ".0";
      var entry = _rrIpTable[ip24];
      if (entry) {
        var countryCode = (_rrCountries[entry.co] || [])[1] || "";
        var regionCode = (_rrRegions[entry.r] || "").toUpperCase();
        var fullCode = countryCode === "US" ? "US-" + regionCode : countryCode;
        var mapKey = RR_CODE_TO_KEY[fullCode];
        if (mapKey && REGION_MAP[mapKey]) {
          var ri = REGION_MAP[mapKey];
          return { region: ri.name, city: ri.name, country: ri.code, group: ri.group };
        }
        // Try country-only fallback
        var cKey = RR_CODE_TO_KEY[countryCode];
        if (cKey && REGION_MAP[cKey]) {
          var ci = REGION_MAP[cKey];
          return { region: ci.name, city: ci.name, country: ci.code, group: ci.group };
        }
      }
    }

    // Fallback: hardcoded CIDR table
    for (var i = 0; i < IP_REGIONS.length; i++) {
      var r = IP_REGIONS[i];
      if (ip.indexOf(r.prefix) === 0) {
        return { region: r.city, city: r.city, country: r.country, flag: r.flag, group: r.group };
      }
    }
    return null;
  }

  // Fetch servers directly from Roblox (Desc = most-filled first, client-side sort handles display)
  async function fetchServersDirect(placeId, cursor) {
    cursor = cursor || "";
    var url = "https://games.roblox.com/v1/games/" + placeId + "/servers/Public?sortOrder=Desc&excludeFullGames=true&limit=100";
    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);

    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var resp = await fetch(url, { credentials: "include" });
        if (resp.status === 429) {
          var ra = parseInt(resp.headers.get("retry-after")) || ((attempt + 1) * 2);
          console.log("[Flux] servers API 429, backoff " + ra + "s");
          await delay(ra * 1000);
          continue;
        }
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return await resp.json();
      } catch (e) {
        if (attempt === 0) console.log("[Flux] fetchServers error:", e.message);
        await delay(1000);
      }
    }
    return { data: [], nextPageCursor: null };
  }

  // Resolve one server's IP via gamejoin (CSRF token, 3 retries, GPS extraction)
  async function resolveServerIP(placeId, serverId) {
    if (_serverCache[serverId] !== undefined) return _serverCache[serverId];

    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var csrf = await getCsrfToken();
        var headers = {
          "Content-Type": "application/json",
          "Referer": "https://www.roblox.com/games/" + placeId + "/",
          "Origin": "https://www.roblox.com",
          "Accept": "application/json"
        };
        if (csrf) headers["X-Csrf-Token"] = csrf;

        var resp = await fetch("https://gamejoin.roblox.com/v1/join-game-instance", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            placeId: parseInt(placeId, 10),
            isTeleport: false,
            gameId: serverId,
            gameJoinAttemptId: crypto.randomUUID ? crypto.randomUUID() : serverId
          }),
          credentials: "include"
        });

        if (resp.status === 403 && resp.headers.get("x-csrf-token")) {
          resetCsrf();
          await delay(100);
          continue;
        }
        if (resp.status === 429) {
          _rateLimitPause = true;  // signal main loop to pause
          var ra429 = parseInt(resp.headers.get("retry-after")) || 4;
          await delay(ra429 * 1000);
          continue;
        }
        if (resp.status === 401 || resp.status !== 200) {
          _serverCache[serverId] = null;
          return null;
        }

        var data = await resp.json();
        var js = data.joinScript;
        if (!js) { _serverCache[serverId] = null; return null; }

        var endpoints = js.UdmuxEndpoints || [];
        if (!endpoints.length || !endpoints[0].Address) {
          _serverCache[serverId] = null; return null;
        }

        var ip = endpoints[0].Address;
        var region = matchIPToRegion(ip);
        var result = { ip: ip };
        if (region) {
          result.region = region.city;
          result.city = region.city;
          result.country = region.country;
          result.flag = region.flag;
          result.group = region.group;
        }
        _serverCache[serverId] = result;
        return result;

      } catch (e) {
        if (attempt === 0) console.log("[Flux] gamejoin error:", e.message);
        await delay(500);
      }
    }
    _serverCache[serverId] = null;
    return null;
  }

  // Main flow: fetch servers → resolve IPs 5 at a time → live UI updates
  async function processAllServers(placeId) {
    if (_activeResolve) return;
    _activeResolve = true;
    var t0 = Date.now();

    console.log("[Flux] fetching server list...");
    var allServers = [];
    var cursor = null;
    var pageCount = 0;
    var MAX_PAGES = 5;  // up to 500 servers

    // Stage 1: Fetch & paginate
    do {
      var page = await fetchServersDirect(placeId, cursor);
      var batch = page.data || [];
      if (!batch.length) break;

      for (var i = 0; i < batch.length; i++) {
        var s = batch[i];
        if (!s.id) continue;
        allServers.push({
          id: s.id,
          playing: s.playing || 0,
          maxPlayers: s.maxPlayers || 0,
          ping: s.ping,
          fps: s.fps,
          playerTokens: s.playerTokens || []
        });
      }
      cursor = page.nextPageCursor;
      pageCount++;
      console.log("[Flux] page " + pageCount + ": " + batch.length + " servers (total: " + allServers.length + ")");
    } while (cursor && pageCount < MAX_PAGES);

    if (!allServers.length) {
      console.log("[Flux] no servers found");
      _activeResolve = false;
      return;
    }

    // Merge with lastGood to preserve previous region data
    var oldById = {};
    lastGood.forEach(function(s) { if (s.id && isReal(s)) oldById[s.id] = s; });
    for (var j = 0; j < allServers.length; j++) {
      if (oldById[allServers[j].id]) {
        var old = oldById[allServers[j].id];
        allServers[j].region = old.region;
        allServers[j].city = old.city;
        allServers[j].country = old.country;
        allServers[j].flag = old.flag;
        allServers[j].group = old.group;
        allServers[j].ip = old.ip;
      }
    }

    lastGood = allServers;
    lastFetch = Date.now();
    failedRefresh = false;
    filtered = applySort(allServers.filter(function(s) { return s.playing > 0 && s.playing < s.maxPlayers; }));
    refreshUI();

    // Stage 2: Resolve IPs in batches of 5
    var toResolve = [];
    for (var k = 0; k < allServers.length; k++) {
      var srv = allServers[k];
      if (srv.region) continue;
      if (srv.playing >= srv.maxPlayers) continue;
      toResolve.push(srv);
    }

    if (toResolve.length) {
      console.log("[Flux] resolving " + toResolve.length + " servers (" + _CONCURRENT + " at a time)...");
      var resolved = 0;
      for (var bi = 0; bi < toResolve.length; bi += _CONCURRENT) {
        // Global rate limit backoff (RoRegion pattern)
        if (_rateLimitPause) {
          console.log("[Flux] rate limit pause, waiting 4s...");
          await delay(4000);
          _rateLimitPause = false;
        }
        var chunk = toResolve.slice(bi, bi + _CONCURRENT);
        await Promise.all(chunk.map(function(srv) {
          return resolveServerIP(placeId, srv.id).then(function(result) {
            if (result && result.region) {
              srv.region = result.region;
              srv.city = result.city;
              srv.country = result.country;
              srv.flag = result.flag;
              srv.group = result.group;
              srv.ip = result.ip;
            }
            resolved++;
          }).catch(function() { resolved++; });
        }));
        // Live sidebar update
        refreshSidebar();
        if (bi + _CONCURRENT < toResolve.length) await delay(50);
      }
      console.log("[Flux] resolved " + resolved + " servers");
    }

    filtered = applySort(allServers.filter(function(s) { return s.playing > 0 && s.playing < s.maxPlayers; }));
    lastFetch = Date.now();
    refreshUI();

    var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    var withRegions = allServers.filter(function(s) { return s.region; }).length;
    console.log("[Flux] DONE: " + withRegions + "/" + allServers.length + " in " + elapsed + "s");
    _activeResolve = false;
  }

  // ── Server helpers ──────────────────────────────────────────────────

  function label(s, list) {
    if (isReal(s)) return s.region + " Server";
    var sorted = applySort(list);
    var pos = sorted.indexOf(s);
    var prefix = activeSort === "best-join" ? "Best Join" : "Server";
    return prefix + " #" + String((pos >= 0 ? pos : 0) + 1).padStart(2, "0");
  }
  function loadLbl(s) { var p = s.playing/s.maxPlayers; return p >= 1 ? "Full" : p >= 0.9 ? "Busy" : p >= 0.6 ? "Moderate" : "Low load"; }
  function regCount() { var set = {}; lastGood.forEach(function(v) { if (isReal(v)) set[v.region] = 1; }); return Object.keys(set).length; }
  function pendCount() { var c = 0; lastGood.forEach(function(v) { if (!isReal(v)) c++; }); return c; }

  function applySort(list) {
    var a = list.slice();
    // Full servers always pushed to bottom
    var nonFull = [], full = [];
    for (var i = 0; i < a.length; i++) {
      if (a[i].playing >= a[i].maxPlayers) full.push(a[i]);
      else nonFull.push(a[i]);
    }
    // Sort non-full servers
    if (activeSort === "ping-lowest") {
      nonFull.sort(function(x,y) { return (x.ping||999) - (y.ping||999) || (y.playing - x.playing); });
    } else if (activeSort === "most-players") {
      nonFull.sort(function(x,y) { return y.playing - x.playing || (x.ping||999) - (y.ping||999); });
    } else if (activeSort === "least-full") {
      nonFull.sort(function(x,y) { return (x.playing/x.maxPlayers) - (y.playing/y.maxPlayers) || (x.ping||999) - (y.ping||999); });
    } else {
      // Default: ping-lowest
      nonFull.sort(function(x,y) { return (x.ping||999) - (y.ping||999) || (y.playing - x.playing); });
    }
    return nonFull.concat(full);
  }

  // ── Extension context guard ─────────────────────────────────────────

  function extOk() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch(e) { return false; }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Play button — RoRegion-style split injection
  // Native Roblox play button stays 70% width → launches game normally.
  // Flux button (30% width, globe icon) → opens Flux dashboard overlay.
  // Container guard prunes Roblox re-injections continuously.
  // ══════════════════════════════════════════════════════════════════════

  function injectFluxStyles() {
    if (document.getElementById('flux-play-btn-styles')) return;
    var styleEl = document.createElement('style');
    styleEl.id = 'flux-play-btn-styles';
    styleEl.textContent =
      '#flux-btn-wrapper { display: inline-flex; align-items: stretch; gap: 6px; vertical-align: middle; }' +
      '#flux-our-play-btn {' +
        'background-color: #10b981 !important;' +
        'border: none !important;' +
        'cursor: pointer !important;' +
        'display: inline-flex !important;' +
        'align-items: center !important;' +
        'justify-content: center !important;' +
        'color: white !important;' +
        'flex-shrink: 0 !important;' +
        'box-shadow: none !important;' +
        'transition: filter 0.15s ease !important;' +
      '}' +
      '#flux-our-play-btn:hover { filter: brightness(1.12) !important; }' +
      '#flux-our-play-btn:active { filter: brightness(0.88) !important; }';
    document.head.appendChild(styleEl);
  }

  function injectOurButton(container) {
    // Don't use toggleReady for gating — it races with setTimeout-based injection.
    // Check DOM directly instead: is the wrapper already present?
    if (document.getElementById('flux-btn-wrapper')) return;
    var robloxBtn = container.querySelector('.btn-common-play-game-lg');
    if (!robloxBtn) return;

    toggleReady = true; // signal that we've started injection (used by polls to know we succeeded)

    function doInject() {
      if (document.getElementById('flux-btn-wrapper')) return;
      if (!robloxBtn.parentNode) { toggleReady = false; return; }

      var fullWidth = robloxBtn.offsetWidth || 300;
      var fullHeight = robloxBtn.offsetHeight || 48;
      var ourSliceWidth = Math.round(fullWidth * 0.30);
      var robloxNewWidth = fullWidth - ourSliceWidth - 6;

      robloxBtn.style.setProperty('width', robloxNewWidth + 'px', 'important');
      robloxBtn.style.setProperty('min-width', '0', 'important');
      robloxBtn.style.setProperty('flex-shrink', '0', 'important');

      var ourBtn = document.createElement('button');
      ourBtn.id = 'flux-our-play-btn';
      ourBtn.type = 'button';
      ourBtn.title = 'Flux Server Finder';

      var iconSize = Math.round(fullHeight * 0.48);
      // RoRegion globe icon — native play button still launches the game
      ourBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="' + iconSize + '" height="' + iconSize + '"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
      ourBtn.style.cssText = 'width:' + ourSliceWidth + 'px;height:' + fullHeight + 'px;border-radius:6px;';

      var wrapper = document.createElement('span');
      wrapper.id = 'flux-btn-wrapper';
      robloxBtn.parentNode.insertBefore(wrapper, robloxBtn);
      wrapper.appendChild(robloxBtn);
      wrapper.appendChild(ourBtn);

      ourBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        openOverlay();
      });

      console.log('[Flux] mounted beside play button');
    }

    // Use setTimeout (works in headless) instead of requestAnimationFrame (only fires during paint cycles)
    setTimeout(doInject, 0);
  }

  // ── Recovery system — detects when Roblox React replaces the container ──
  // Slow poll (2s) monitors wrapper health. When wrapper disappears, a fast
  // poll (200ms) fires up and keeps re-injecting until the button sticks.
  // This handles Roblox React nuking + recreating the container at any speed.

  var _recoveryPoll = null;
  var _fastPoll = null;

  function startFastPoll() {
    if (_fastPoll) return;
    var attempts = 0;
    console.log('[Flux] starting fast recovery poll...');
    _fastPoll = setInterval(function() {
      attempts++;
      var c = document.getElementById('game-details-play-button-container');
      if (!c) return; // container not back yet — keep waiting
      injectOurButton(c);
      if (toggleReady) {
        // Re-injection succeeded
        clearInterval(_fastPoll);
        _fastPoll = null;
        console.log('[Flux] recovery re-injection successful');
      } else if (attempts >= 150) { // 30 seconds max
        clearInterval(_fastPoll);
        _fastPoll = null;
        console.log('[Flux] recovery gave up after 30s');
      }
    }, 200);
  }

  function startRecoveryPoll() {
    if (_recoveryPoll) return;
    _recoveryPoll = setInterval(function() {
      var wrapper = document.getElementById('flux-btn-wrapper');
      if (wrapper && wrapper.parentNode && wrapper.parentNode.id === 'game-details-play-button-container') {
        return; // still intact — nothing to do
      }

      // Wrapper is gone or detached — Roblox replaced the container
      toggleReady = false;
      if (!_fastPoll) {
        console.log('[Flux] wrapper lost, starting fast recovery...');
        startFastPoll();
      }
    }, 2000); // check every 2s — lightweight
  }

  function tryInjectToggle() {
    injectFluxStyles();
    var container = document.getElementById('game-details-play-button-container');
    if (container) {
      injectOurButton(container);
    }

    // Initial poll — wait for the button to appear (container exists but button hasn't rendered yet)
    var attempts = 0;
    var MAX_ATTEMPTS = 75; // 15 seconds
    var poll = setInterval(function() {
      attempts++;
      var c = document.getElementById('game-details-play-button-container');
      if (!c) {
        if (attempts >= MAX_ATTEMPTS) clearInterval(poll);
        return;
      }
      injectOurButton(c);
      if (toggleReady) {
        clearInterval(poll);
        startRecoveryPoll(); // switch to long-term recovery mode
      } else if (attempts >= MAX_ATTEMPTS) {
        clearInterval(poll);
        console.log('[Flux] gave up waiting for play button after ' + MAX_ATTEMPTS + ' attempts');
      }
    }, 200);
  }

  // ── Game launch listener (from background.js) ─────────────────────
  // Server resolution is now done directly in content.js — no Python backend needed.

  // ── Fetch (extension-only — direct Roblox API calls) ──────────────

  function doFetch() {
    var p = pid(); if (!p) return;
    if (!extOk()) { console.log("[Flux] extension context lost — reload the extension"); return; }
    console.log("[Flux] refresh started");
    if (refreshing || _activeResolve) return;
    refreshing = true;
    failedRefresh = false;

    processAllServers(p).then(function() {
      refreshing = false;
    }).catch(function(e) {
      refreshing = false;
      failedRefresh = true;
      console.log("[Flux] processAllServers error:", e.message);
      refreshUI();
    });
  }

  // ── Overlay ─────────────────────────────────────────────────────────

  function openOverlay() {
    var old = document.querySelector(".flux-overlay");
    if (old) { closeOverlay(old); return; }
    if (!lastGood.length) doFetch();

    var overlay = document.createElement("div");
    overlay.className = "flux-overlay";
    overlay.id = "flux-unified-overlay";
    overlay.innerHTML = '<div class="flux-modal flux-modal-in">' +
      '<div class="flux-head">' +
        '<h3>Flux</h3>' +
        '<button class="flux-x">&times;</button>' +
      '</div>' +
      '<div class="flux-body"></div>' +
    '</div>';
    overlay.querySelector(".flux-x").onclick = function() { closeOverlay(overlay); };
    overlay.addEventListener("click", function(e) { if (e.target === overlay) closeOverlay(overlay); });
    document.addEventListener("keydown", function escCB(e) { if (e.key === "Escape") { closeOverlay(overlay); document.removeEventListener("keydown", escCB); } });
    document.body.style.overflow = "hidden";
    document.body.appendChild(overlay);
    buildDashboard(overlay);
    startAuto();
  }

  function closeOverlay(overlay) {
    if (!overlay) { var o = document.querySelector(".flux-overlay"); if (o) { closeOverlay(o); } return; }
    overlay.classList.add("flux-overlay-out");
    document.body.style.overflow = "";
    setTimeout(function() { if (overlay.parentNode) overlay.remove(); clearAuto(); }, 200);
  }

  // ── Join specific server ─────────────────────────────────────────────

  function joinSpecificServer(placeId, serverId) {
    console.log("[Flux] launching server: " + serverId);
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: "flux.launchGame",
        placeId: placeId,
        instanceId: serverId
      });
    }
  }

  // ── Dashboard builder ────────────────────────────────────────────────

  function buildDashboard(overlay) {
    var body = overlay.querySelector(".flux-body");
    body.innerHTML = "";

    var dash = document.createElement("div");
    dash.className = "flux-dash";

    // ── LEFT: Sidebar — always shows all regions ──────────────────────
    var left = document.createElement("div");
    left.className = "flux-dash-left";
    left.innerHTML = '<div class="flux-sidebar-header">Server Locations</div><div class="flux-side">' + dashSidebar() + '</div>';
    dash.appendChild(left);

    // ── RIGHT: Default dashboard (server cards only on region click) ──
    var right = document.createElement("div");
    right.className = "flux-dash-right";
    right.id = "flux-right-panel";

    // Header
    var hdr = document.createElement("div");
    hdr.className = "flux-main-header";
    hdr.innerHTML = '<h2 class="flux-main-title">Flux Dashboard</h2><button class="flux-close-pill flux-dash-close">Close</button>';
    right.appendChild(hdr);

    // Default panel content
    var defaultPanel = document.createElement("div");
    defaultPanel.className = "flux-default-panel";

    // Community section
    var secLabel = document.createElement("div");
    secLabel.className = "flux-section-label";
    secLabel.textContent = "COMMUNITY";
    defaultPanel.appendChild(secLabel);

    defaultPanel.appendChild(buildPromoCard());
    right.appendChild(defaultPanel);

    dash.appendChild(right);
    body.appendChild(dash);
    wireDashboard(overlay);
  }

  function buildPromoCard() {
    var card = document.createElement("div");
    card.className = "flux-promo-card";
    card.innerHTML =
      '<div class="flux-promo-left">' +
        '<div class="flux-promo-title">Join our Discord</div>' +
        '<div class="flux-promo-desc">Get updates, report bugs, and chat with other Flux users!</div>' +
      '</div>' +
      '<div class="flux-promo-right">' +
        '<span class="flux-promo-arrow">→</span>' +
        '<a class="flux-promo-btn" href="#" target="_blank" rel="noopener noreferrer">Join Server</a>' +
      '</div>';
    return card;
  }

  // ── Region server view — replaces right panel when a region is clicked ──

  function showRegionServers(regionKey) {
    var right = document.getElementById("flux-right-panel");
    if (!right) return;
    right.innerHTML = "";

    // Parse region
    var parts = regionKey.split("|");
    var displayName = parts.slice(1).join("|");
    var flagUrl = getFlagUrl(displayName);

    // Header with flag + back button + close
    var hdr = document.createElement("div");
    hdr.className = "flux-main-header";

    var titleEl = document.createElement("div");
    titleEl.className = "flux-main-title";
    if (flagUrl) {
      var flagImg = document.createElement("img");
      flagImg.src = flagUrl;
      flagImg.alt = "";
      titleEl.appendChild(flagImg);
    }
    titleEl.appendChild(document.createTextNode("Servers in " + displayName));
    hdr.appendChild(titleEl);

    var backBtn = document.createElement("button");
    backBtn.className = "flux-back-btn";
    backBtn.textContent = "← Back";
    backBtn.onclick = function() {
      selectedRegion = null;
      rebuildRightPanel();
    };
    hdr.appendChild(backBtn);
    right.appendChild(hdr);

    // Filter servers
    var servers;
    if (regionKey === "UNKNOWN|__unmatched") {
      servers = lastGood;
    } else {
      servers = lastGood.filter(function(s) {
        return getRegionInfo(s.region).name === displayName;
      });
    }

    // Stats bar
    var statsBar = document.createElement("div");
    statsBar.className = "flux-stats-bar";
    var resolved = servers.filter(function(s) { return s.region && s.region !== "Pending" && s.region !== "Unknown"; }).length;
    statsBar.textContent = servers.length + " servers · " + resolved + " resolved · Updated " + timeAgo(lastFetch);
    right.appendChild(statsBar);

    // Sort bar (RoRegion-style: ping, most players, least full)
    var sortBar = document.createElement("div");
    sortBar.className = "flux-sort-bar";
    var SORTS = [
      { key: "ping-lowest", label: "Ping ↑" },
      { key: "most-players", label: "Most Players" },
      { key: "least-full", label: "Least Full" }
    ];
    for (var si = 0; si < SORTS.length; si++) {
      var sb = document.createElement("button");
      sb.className = "flux-sort-btn" + (activeSort === SORTS[si].key ? " active" : "");
      sb.textContent = SORTS[si].label;
      sb.dataset.sort = SORTS[si].key;
      sb.onclick = function() {
        activeSort = this.dataset.sort;
        showRegionServers(right._viewingRegion || selectedRegion);
      };
      sortBar.appendChild(sb);
    }
    right.appendChild(sortBar);

    // Server grid
    var serverGrid = document.createElement("div");
    serverGrid.className = "flux-server-grid";
    serverGrid.id = "flux-server-grid";
    serverGrid._regionServers = servers;  // pass filtered servers
    right.appendChild(serverGrid);
    renderServerGrid(serverGrid);

    // Store for refresh
    right._viewingRegion = regionKey;
  }

  function rebuildRightPanel() {
    // Rebuild right panel to default dashboard view
    var right = document.getElementById("flux-right-panel");
    if (!right) return;
    right.innerHTML = "";

    var hdr = document.createElement("div");
    hdr.className = "flux-main-header";
    hdr.innerHTML = '<h2 class="flux-main-title">Flux Dashboard</h2><button class="flux-close-pill flux-dash-close">Close</button>';
    right.appendChild(hdr);

    var defaultPanel = document.createElement("div");
    defaultPanel.className = "flux-default-panel";

    var secLabel = document.createElement("div");
    secLabel.className = "flux-section-label";
    secLabel.textContent = "COMMUNITY";
    defaultPanel.appendChild(secLabel);

    defaultPanel.appendChild(buildPromoCard());
    right.appendChild(defaultPanel);
    right._viewingRegion = null;

    // Re-wire close button
    var closeBtn = right.querySelector(".flux-dash-close");
    if (closeBtn) {
      var overlay = document.querySelector(".flux-overlay");
      if (overlay) closeBtn.onclick = function() { closeOverlay(overlay); };
    }

    // Refresh sidebar to clear selection highlight
    refreshSidebar();
  }

  // ── Sidebar — always shows all known datacenter locations ──────────

  function dashSidebar() {
    // Build server count lookup from live data
    var counts = {};
    var mappedTotal = 0;
    var knownNames = {};
    for (var key in REGION_MAP) { knownNames[REGION_MAP[key].name] = true; }

    lastGood.forEach(function(s) {
      var displayName = getRegionInfo(s.region).name;
      counts[displayName] = (counts[displayName] || 0) + 1;
      if (knownNames[displayName]) mappedTotal++;
    });

    var unmatchedTotal = lastGood.length - mappedTotal;

    // Build ordered list of all REGION_MAP entries grouped by continent
    var ORDER = ["EUROPE", "ASIA", "NORTH AMERICA", "OCEANIA", "SOUTH AMERICA"];
    var entries = [];
    for (var key in REGION_MAP) {
      entries.push({ key: key, info: REGION_MAP[key] });
    }
    entries.sort(function(a, b) {
      var oa = ORDER.indexOf(a.info.group), ob = ORDER.indexOf(b.info.group);
      if (oa === -1) oa = 99; if (ob === -1) ob = 99;
      if (oa !== ob) return oa - ob;
      return a.info.name.localeCompare(b.info.name);
    });

    // Build HTML — grouped by continent
    var html = "";
    var lastGroup = "";
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var info = e.info;
      var group = info.group;
      var displayName = info.name;
      var count = counts[displayName] || 0;
      var countText = count + " server" + (count !== 1 ? "s" : "");
      var regionKey = group + "|" + displayName;

      if (group !== lastGroup) {
        if (lastGroup !== "") html += '</div>';
        lastGroup = group;
        html += '<div class="flux-region-group">';
        html += '<div class="flux-region-group-label">' + group + '</div>';
        html += '<div class="flux-region-group-divider"></div>';
      }

      var isSel = selectedRegion === regionKey ? " selected" : "";
      var hasServers = count > 0;
      var flagUrl2 = getFlagUrl(displayName);
      html += '<div class="flux-loc-row' + isSel + '" data-region-key="' + regionKey + '" data-has-servers="' + (hasServers ? "1" : "0") + '">';
      if (flagUrl2) {
        html += '<img class="flux-loc-flag" src="' + flagUrl2 + '" alt="" />';
      } else {
        html += '<span class="flux-loc-flag" style="display:inline-block;width:20px;text-align:center">🌐</span>';
      }
      html += '<span class="flux-loc-name">' + displayName + '</span>';
      html += '<span class="flux-loc-pill">' + countText + '</span>';
      html += '<button class="flux-loc-action" title="Join random server"><svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px"><path d="M8 5v14l11-7z"/></svg></button>';
      html += '</div>';
    }

    // Fallback: unmatched servers (no region data from backend yet)
    if (unmatchedTotal > 0) {
      html += '<div class="flux-region-group">';
      html += '<div class="flux-region-group-label">UNKNOWN</div>';
      html += '<div class="flux-region-group-divider"></div>';
      var uCountText = unmatchedTotal + " server" + (unmatchedTotal !== 1 ? "s" : "");
      html += '<div class="flux-loc-row" data-region-key="UNKNOWN|__unmatched" data-has-servers="1">';
      html += '<span class="flux-loc-flag">🌐</span>';
      html += '<span class="flux-loc-name">All Servers</span>';
      html += '<span class="flux-loc-pill">' + uCountText + '</span>';
      html += '<button class="flux-loc-action" title="Join random server"><svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px"><path d="M8 5v14l11-7z"/></svg></button>';
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';  // close last mapped group
    html += '<div class="flux-loader">' + lastGood.length + ' servers scanned</div>';
    return html;
  }

  async function renderServerGrid(container) {
    container.innerHTML = "";

    // Get servers based on filter
    var servers;
    if (container._regionServers) {
      servers = container._regionServers;
    } else {
      // Determine from selected region
      if (selectedRegion) {
        var parts = selectedRegion.split("|");
        var displayName = parts.slice(1).join("|");
        if (selectedRegion === "UNKNOWN|__unmatched") {
          servers = lastGood;
        } else {
          servers = lastGood.filter(function(s) {
            return getRegionInfo(s.region).name === displayName;
          });
        }
      } else {
        servers = lastGood;
      }
    }

    // Filter and apply active sort mode
    servers = servers.filter(function(s) { return s.playing > 0 && s.playing < s.maxPlayers; });
    servers = applySort(servers);

    if (!servers.length) {
      container.innerHTML = '<div class="flux-empty">No servers found. Try refreshing.</div>';
      return;
    }

    // Fetch thumbnails for first batch
    var batch = servers.slice(0, BATCH_SIZE);
    var allTokens = [];
    batch.forEach(function(s) { if (s.playerTokens) allTokens = allTokens.concat(s.playerTokens.slice(0, 5)); });
    var thumbs = await fetchThumbnails(allTokens);

    // Render cards
    for (var i = 0; i < batch.length; i++) {
      container.appendChild(createServerCard(batch[i], thumbs));
    }
    var visibleCount = batch.length;

    // Load More
    if (servers.length > BATCH_SIZE) {
      var serversRef = servers;
      var loadMore = document.createElement("button");
      loadMore.className = "flux-load-more";
      loadMore.textContent = "Load More Servers (" + (servers.length - BATCH_SIZE) + " remaining)";
      loadMore.onclick = async function() {
        loadMore.textContent = "Loading...";
        loadMore.style.opacity = "0.7";
        var next = serversRef.slice(visibleCount, visibleCount + BATCH_SIZE);
        var nextTokens = [];
        next.forEach(function(s) { if (s.playerTokens) nextTokens = nextTokens.concat(s.playerTokens.slice(0, 5)); });
        var nextThumbs = await fetchThumbnails(nextTokens);
        for (var j = 0; j < next.length; j++) {
          container.insertBefore(createServerCard(next[j], nextThumbs), loadMore);
        }
        visibleCount += next.length;
        if (visibleCount >= serversRef.length) {
          loadMore.remove();
        } else {
          loadMore.textContent = "Load More Servers (" + (serversRef.length - visibleCount) + " remaining)";
          loadMore.style.opacity = "1";
        }
      };
      container.appendChild(loadMore);
    }
  }

  function createServerCard(server, thumbnails) {
    thumbnails = thumbnails || {};
    var card = document.createElement("div");
    card.className = "flux-server-card";

    var isFull = server.playing >= server.maxPlayers;
    var playerTokens = server.playerTokens || [];

    // ── Player avatars row ────────────────────────────────────
    var avatarsRow = document.createElement("div");
    avatarsRow.className = "flux-avatars-row";

    var maxThumbs = 5;
    var playersToShow = Math.min(server.playing, playerTokens.length, maxThumbs);

    if (server.playing === 0) {
      var empty = document.createElement("div");
      empty.style.cssText = "font-size:14px;color:#888;font-style:italic;padding:8px 0;line-height:60px;";
      empty.textContent = "No players online";
      avatarsRow.appendChild(empty);
    } else if (playersToShow > 0) {
      for (var i = 0; i < playersToShow; i++) {
        var img = document.createElement("img");
        img.className = "flux-avatar";
        var token = playerTokens[i];
        if (token && thumbnails[token]) {
          img.src = thumbnails[token];
        } else {
          img.src = "https://tr.rbxcdn.com/53eb9b17fe1432a809c73a13889b5006/150/150/Image/Png";
        }
        img.alt = "";
        avatarsRow.appendChild(img);
      }
      // "+N" for extra players beyond 5 shown tokens
      if (server.playing > maxThumbs && playerTokens.length >= maxThumbs) {
        var plus = document.createElement("div");
        plus.className = "flux-avatar-plus";
        plus.textContent = "+" + (server.playing - maxThumbs);
        avatarsRow.appendChild(plus);
      }
    } else {
      // Tokens not available — show placeholder count
      var phCount = Math.min(server.playing, maxThumbs);
      for (var j = 0; j < phCount; j++) {
        var ph = document.createElement("img");
        ph.className = "flux-avatar";
        ph.src = "https://tr.rbxcdn.com/53eb9b17fe1432a809c73a13889b5006/150/150/Image/Png";
        avatarsRow.appendChild(ph);
      }
      if (server.playing > maxThumbs) {
        var plus2 = document.createElement("div");
        plus2.className = "flux-avatar-plus";
        plus2.textContent = "+" + (server.playing - maxThumbs);
        avatarsRow.appendChild(plus2);
      }
    }

    card.appendChild(avatarsRow);

    // ── Player count (RoRegion: 16px, bold) ───────────────────────
    var countText = document.createElement("div");
    countText.className = "flux-player-count";
    countText.textContent = server.playing + " / " + server.maxPlayers + " players";
    card.appendChild(countText);

    // ── Ping (RoRegion: 15px, color-coded) ────────────────────────
    if (server.ping !== undefined && server.ping !== null && server.ping !== Infinity && !isNaN(server.ping)) {
      var pingRow = document.createElement("div");
      pingRow.className = "flux-ping-row";
      var pingVal = Math.round(server.ping);
      if (pingVal < 80) pingRow.classList.add("flux-ping-green");
      else if (pingVal < 150) pingRow.classList.add("flux-ping-yellow");
      else pingRow.classList.add("flux-ping-red");
      pingRow.textContent = "Ping: " + pingVal + "ms";
      card.appendChild(pingRow);
    } else {
      var pingUnknown = document.createElement("div");
      pingUnknown.className = "flux-ping-row";
      pingUnknown.style.color = "#aaa";
      pingUnknown.textContent = "Ping: ?";
      card.appendChild(pingUnknown);
    }

    // ── Join button (RoRegion: 48px, #3975e0) ─────────────────────
    var joinBtn = document.createElement("button");
    joinBtn.className = "flux-join-btn";
    if (isFull) {
      joinBtn.classList.add("flux-join-full");
      joinBtn.textContent = "Full";
      joinBtn.disabled = true;
    } else {
      joinBtn.textContent = "Join";
      joinBtn.onclick = function() {
        joinSpecificServer(pid(), server.id);
        var overlay = document.querySelector(".flux-overlay");
        if (overlay) {
          var modal = overlay.querySelector(".flux-modal");
          if (modal) { modal.style.transform = "scale(0.95)"; modal.style.opacity = "0"; }
          overlay.classList.add("flux-overlay-out");
          document.body.style.overflow = "";
          setTimeout(function() { if (overlay.parentNode) overlay.remove(); clearAuto(); }, 200);
        }
      };
    }
    card.appendChild(joinBtn);

    return card;
  }

  // ── Wire dashboard interactions ─────────────────────────────────────

  function wireSidebar(overlay) {
    // Region row clicks — select/unselect
    overlay.querySelectorAll(".flux-loc-row").forEach(function(row) {
      // Skip if already wired (has click handler from previous build)
      if (row.dataset.wired === "1") return;
      row.dataset.wired = "1";
      row.onclick = function(e) {
        if (e.target.closest(".flux-loc-action")) return;
        var key = row.dataset.regionKey;
        if (selectedRegion === key) {
          // Deselect — go back to default dashboard
          selectedRegion = null;
          rebuildRightPanel();
        } else {
          selectedRegion = key;
          showRegionServers(key);
          refreshSidebar(); // update highlight
        }
      };
    });

    // Play button — join random server via Roblox.GameLauncher
    overlay.querySelectorAll(".flux-loc-action").forEach(function(btn) {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.onclick = function(e) {
        e.stopPropagation();
        var row = btn.closest(".flux-loc-row");
        if (!row || row.dataset.hasServers !== "1") return;
        var key = row.dataset.regionKey;

        // Pick matching servers
        var matching;
        if (key === "UNKNOWN|__unmatched") {
          matching = lastGood;
        } else {
          var parts = key.split("|");
          var displayName = parts.slice(1).join("|");
          matching = lastGood.filter(function(s) {
            return getRegionInfo(s.region).name === displayName;
          });
        }

        if (!matching.length) return;

        var pick = matching[Math.floor(Math.random() * matching.length)];
        console.log("[Flux] launching server: " + pick.id);

        if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            type: "flux.launchGame",
            placeId: pid(),
            instanceId: pick.id
          });
        }
      };
    });
  }

  function wireDashboard(overlay) {
    // Close pill
    var closePill = overlay.querySelector(".flux-dash-close");
    if (closePill) closePill.onclick = function() { closeOverlay(overlay); };

    // Sidebar interactions
    wireSidebar(overlay);
  }

  function refreshSidebar() {
    // Only update the sidebar rows — no full dashboard rebuild, no flicker
    var side = document.querySelector(".flux-side");
    if (!side) return;
    var wasScrolled = side.scrollTop;
    side.innerHTML = dashSidebar();
    side.scrollTop = wasScrolled;
    // Re-wire click handlers on new rows
    var overlay = document.querySelector(".flux-overlay");
    if (overlay) wireSidebar(overlay);
  }

  function refreshUI() {
    // Update sidebar (preserves scroll)
    refreshSidebar();
    // If viewing a region, refresh its server cards
    var right = document.getElementById("flux-right-panel");
    if (right && right._viewingRegion) {
      showRegionServers(right._viewingRegion);
    }
  }

  // ── Auto-refresh ────────────────────────────────────────────────────

  function startAuto() { clearAuto(); autoTimer = setInterval(function() { if (document.querySelector(".flux-overlay")) doFetch(); }, 30000); }
  function clearAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

  // ── Init ────────────────────────────────────────────────────────────

  async function init() {
    if (!isGamePage()) return;
    tryInjectToggle();     // RoRegion-style — split native play button, add Flux dashboard button beside it
    await loadRRIpTable(); // RoRegion CIDR table (cached 24h) — MUST load before resolution
    if (pid()) doFetch();  // now safe — IP table is ready
  }

  var domDone = false;
  var navObserver = null;
  function onDOM() {
    if (domDone) return; domDone = true;
    setTimeout(init, 800);
    // SPA navigation watcher
    if (navObserver) navObserver.disconnect();
    navObserver = new MutationObserver(function() {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        lastGood = []; filtered = []; selectedRegion = null; // discard old game's servers
        var o = document.querySelector(".flux-overlay"); if (o) { closeOverlay(o); }
        clearAuto();
        domDone = false; toggleReady = false;
        if (_recoveryPoll) { clearInterval(_recoveryPoll); _recoveryPoll = null; }
        if (_fastPoll) { clearInterval(_fastPoll); _fastPoll = null; }
        setTimeout(onDOM, 800);
      }
    });
    navObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Robust init — try multiple strategies to catch the DOM ready moment.
  // document_start means body may not exist yet. MutationObserver on
  // documentElement is fragile in some Chrome builds — use DOMContentLoaded
  // as a reliable fallback.
  function boot() {
    if (domDone) return;
    try {
      if (document.body) { onDOM(); return true; }
    } catch(e) { console.log('[Flux] boot check error:', e.message); }
    return false;
  }

  if (boot()) { /* ready immediately */ }
  else {
    // Strategy 1: MutationObserver — wait for <body> to be appended
    try {
      var _bootObs = new MutationObserver(function() {
        if (boot()) { _bootObs.disconnect(); }
      });
      _bootObs.observe(document.documentElement || document, { childList: true, subtree: true });
      // Safety timeout — if MutationObserver never fires, try DOMContentLoaded
      setTimeout(function() {
        if (!domDone) {
          console.log('[Flux] MutationObserver timed out, falling back to DOMContentLoaded');
          _bootObs.disconnect();
          boot();
        }
      }, 2000);
    } catch(e) {
      console.log('[Flux] observer setup failed:', e.message);
      // Strategy 2: DOMContentLoaded as last resort
      document.addEventListener('DOMContentLoaded', function() { boot(); });
    }
  }
})();

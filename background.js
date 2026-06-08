const API_BASE_DEFAULT = "https://n8n.srv875745.hstgr.cloud/webhook";


function rrLaunchGameInstance(placeId, instanceId) {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobile) {
    const url = instanceId
      ? `https://www.roblox.com/games/start?placeid=${placeId}&gameId=${instanceId}`
      : `https://www.roblox.com/games/start?placeid=${placeId}`;
    const a = document.createElement('a');
    a.href = url; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } else {
    try {
      if (window.Roblox?.GameLauncher?.joinGameInstance) {
        window.Roblox.GameLauncher.joinGameInstance(placeId, instanceId);
      } else {
        throw new Error('GameLauncher unavailable');
      }
    } catch (err) {
      window.location.href = instanceId
        ? `roblox://placeId=${placeId}&gameInstanceId=${instanceId}`
        : `roblox://placeId=${placeId}`;
    }
  }
}


async function getApiBase() {
  const storage = await chrome.storage.local.get(["fluxApiBase"]);
  return (storage.fluxApiBase || API_BASE_DEFAULT).replace(/\/+$/, "");
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;


  if (message.type === "flux.getConfig") {
    getApiBase()
      .then(apiBase => sendResponse({ ok: true, apiBase }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "flux.setApiBase") {
    const apiBase = String(message.apiBase || "").trim().replace(/\/+$/, "");
    chrome.storage.local
      .set({ fluxApiBase: apiBase || API_BASE_DEFAULT })
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "flux.resetApiBase") {
    chrome.storage.local.remove(["fluxApiBase"])
      .then(() => sendResponse({ ok: true, apiBase: API_BASE_DEFAULT }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }


  if (message.type === "flux.getIdentity") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["fluxIdentity"]);
        if (stored.fluxIdentity && !message.forceRefresh) {
          sendResponse(stored.fluxIdentity);
          return;
        }
        const cookie = await chrome.cookies.get({
          url: "https://www.roblox.com", name: ".ROBLOSECURITY"
        });
        if (!cookie) { sendResponse({ ok: false, error: "not_logged_in" }); return; }
        const res = await fetch("https://users.roblox.com/v1/users/authenticated", {
          headers: { Cookie: `.ROBLOSECURITY=${cookie.value}` }
        });
        if (!res.ok) { sendResponse({ ok: false, error: `roblox_api_${res.status}` }); return; }
        const body = await res.json();
        const result = {
          ok: true,
          identity: { userId: String(body.id), username: body.name, displayName: body.displayName }
        };
        await chrome.storage.local.set({ fluxIdentity: result });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message) });
      }
    })();
    return true;
  }

  if (message.type === "flux.refreshIdentity") {
    chrome.storage.local.remove(["fluxIdentity"])
      .then(() => {
        chrome.runtime.sendMessage({ type: "flux.getIdentity", forceRefresh: true })
          .then(r => sendResponse(r))
          .catch(e => sendResponse({ ok: false, error: String(e) }));
      });
    return true;
  }



  if (message.type === "flux.launchGame") {
    if (!sender.tab || !sender.tab.id) {
      sendResponse({ ok: false, error: "no_tab" });
      return false;
    }
    const placeId = parseInt(message.placeId, 10);
    const instanceId = message.instanceId || "";
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: rrLaunchGameInstance,
      args: [placeId, instanceId],
      world: 'MAIN',
    })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

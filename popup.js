async function getConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "flux.getConfig" }, (res) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      resolve(res || { ok: false });
    });
  });
}

async function setApiBase(apiBase) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "flux.setApiBase", apiBase }, (res) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      resolve(res || { ok: false });
    });
  });
}

async function init() {
  const input = document.getElementById("apiBase");
  const msg = document.getElementById("msg");
  const saveBtn = document.getElementById("saveBtn");

  const cfg = await getConfig();
  if (cfg.ok) input.value = cfg.apiBase || "";

  saveBtn.addEventListener("click", async () => {
    msg.textContent = "Saving...";
    const apiBase = input.value.trim();
    const res = await setApiBase(apiBase);
    msg.textContent = res.ok ? "Saved." : `Save failed: ${res.error || "unknown error"}`;
  });
}

init();

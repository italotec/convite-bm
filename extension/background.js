// Service worker: holds the baked-in API key (config.js, replaced per-user by
// app/routes/extension_bp.py at download time), resolves the current AdsPower profile, and is the
// only part of the extension allowed to talk to the Convite BM server (host_permissions is scoped
// to baseUrl so this needs no CORS workaround). Also opens tab/tab.html when the toolbar icon is
// clicked, since this extension is a full tab, not a popup.
//
// A broken config.js must never take the whole worker down silently (this exact failure mode is
// documented in Manager Lite's background.js: config.js writing to `window`, which doesn't exist
// in a service worker, throws on importScripts and chrome.runtime.onMessage never registers). So
// this always finishes booting and reports the failure through the normal message responses
// instead of letting the SW die.
let CONFIG_ERROR = null;
try {
  importScripts("config.js");
} catch (e) {
  CONFIG_ERROR = String((e && e.message) || e);
}
const CFG = self.__CB_CONFIG__ || { apiKey: "", baseUrl: "http://localhost:5020", email: "" };
if (!self.__CB_CONFIG__ && !CONFIG_ERROR) {
  CONFIG_ERROR = "config.js não definiu __CB_CONFIG__.";
}

const PROFILE_CACHE_KEY = "cbProfileInfo";
const MANUAL_PROFILE_KEY = "cbManualProfileInfo";

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("tab/tab.html") });
});

function apiBase() {
  return (CFG.baseUrl || "").replace(/\/+$/, "");
}

function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, Object.assign({}, opts, { signal: controller.signal }))
    .finally(() => clearTimeout(timer));
}

// ── AdsPower profile — manual override ──────────────────────────────────────
// chrome.storage.local is per Chrome profile, i.e. per AdsPower profile — typing this once here
// sticks for that profile forever, and always wins over auto-detection.

async function getManualProfile() {
  const stored = await chrome.storage.local.get(MANUAL_PROFILE_KEY);
  const m = stored[MANUAL_PROFILE_KEY];
  return m && m.profileId ? m : null;
}

async function setManualProfile(profileId, serialNumber) {
  const info = {
    profileId: String(profileId || "").trim(),
    serialNumber: String(serialNumber || "").trim(),
    manual: true,
    detectedAt: Date.now(),
  };
  await chrome.storage.local.set({ [MANUAL_PROFILE_KEY]: info });
  return info;
}

// ── AdsPower profile — auto-detection ────────────────────────────────────────
// https://start.adspower.net/?id= is rewritten by the AdsPower browser build itself, in-address-bar,
// to https://start.adspower.net/?id=<profile_id>&host=127.0.0.1:<local_api_port>. Same technique
// as I:\Manager Lite\extension\background.js. http://<host>/api/getBrowserInfo?id=<id> then hands
// back the profile's serial number (accId/browser_head).

function isResolvedStartUrl(url) {
  return !!url && /[?&]id=/.test(url) && /[?&]host=/.test(url);
}

function resolveViaHiddenTab() {
  return new Promise((resolve) => {
    chrome.tabs.create({ url: "https://start.adspower.net/?id=", active: false }, (tab) => {
      if (!tab || !tab.id) { resolve(null); return; }
      const tabId = tab.id;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        chrome.tabs.remove(tabId).catch(() => {});
        resolve(result);
      };

      const listener = (updatedTabId, changeInfo, updatedTab) => {
        if (updatedTabId !== tabId) return;
        if (isResolvedStartUrl(changeInfo.url)) finish(changeInfo.url);
        else if (changeInfo.status === "complete" && isResolvedStartUrl(updatedTab.url)) finish(updatedTab.url);
      };
      chrome.tabs.onUpdated.addListener(listener);

      const timer = setTimeout(() => finish(null), 4000);
    });
  });
}

async function resolveStartUrl() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://start.adspower.net/*" });
    for (const t of tabs) {
      if (isResolvedStartUrl(t.url)) return t.url;
    }
  } catch (_) {}
  return resolveViaHiddenTab();
}

async function detectAdsPowerProfile(force) {
  const manual = await getManualProfile();
  if (manual) return manual;

  if (!force) {
    const cached = await chrome.storage.local.get(PROFILE_CACHE_KEY);
    if (cached[PROFILE_CACHE_KEY] && cached[PROFILE_CACHE_KEY].profileId) {
      return cached[PROFILE_CACHE_KEY];
    }
  }

  const resolvedUrl = await resolveStartUrl();
  if (!resolvedUrl) return null;

  const url = new URL(resolvedUrl);
  const id = url.searchParams.get("id");
  const host = url.searchParams.get("host");
  if (!id || !host) return null;

  const info = { profileId: id, serialNumber: "", groupName: "", detectedAt: Date.now() };
  try {
    const r = await fetchWithTimeout(`http://${host}/api/getBrowserInfo?id=${encodeURIComponent(id)}`, {}, 5000);
    const body = await r.json();
    if (body && body.code === 0 && body.data) {
      info.serialNumber = String(body.data.accId || body.data.browser_head || "");
      info.groupName = body.data.batch_name || "";
    }
  } catch (_) {
    // getBrowserInfo failing still leaves us the profile id — better than nothing.
  }

  await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: info });
  return info;
}

// ── Convite BM API ─────────────────────────────────────────────────────────

function configError() {
  if (CONFIG_ERROR) {
    return `Extensão com configuração inválida: ${CONFIG_ERROR} Baixe novamente em Minha Conta.`;
  }
  if (!CFG.apiKey) {
    return "Extensão sem chave de API — baixe novamente em Minha Conta no Convite BM.";
  }
  return null;
}

async function fetchMe() {
  const err = configError();
  if (err) return { ok: false, error: err };
  try {
    const resp = await fetchWithTimeout(`${apiBase()}/api/v1/me`, {
      headers: { Authorization: `Bearer ${CFG.apiKey}` },
    }, 15000);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: body.error || `HTTP ${resp.status}` };
    return body;
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "timeout ao contatar o Convite BM" : String(e) };
  }
}

async function checkInvites(businessIds) {
  const err = configError();
  if (err) return { ok: false, error: err };
  try {
    const resp = await fetchWithTimeout(`${apiBase()}/api/v1/invites/check`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ business_ids: businessIds }),
    }, 15000);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: body.error || `HTTP ${resp.status}` };
    return body;
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "timeout ao contatar o Convite BM" : String(e) };
  }
}

async function reportInvite(payload) {
  const err = configError();
  if (err) return { ok: false, error: err };
  try {
    const resp = await fetchWithTimeout(`${apiBase()}/api/v1/invites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 15000);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: body.error || `HTTP ${resp.status}` };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "timeout ao registrar no Convite BM" : String(e) };
  }
}

// ── Message router (tab.js -> here) ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "cb-get-config") {
    fetchMe().then(sendResponse);
    return true;
  }
  if (msg.type === "cb-detect-profile") {
    detectAdsPowerProfile(!!msg.force)
      .then((info) => sendResponse({ ok: !!info, info }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "cb-set-manual-profile") {
    setManualProfile(msg.profileId, msg.serialNumber)
      .then((info) => sendResponse({ ok: true, info }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "cb-clear-manual-profile") {
    chrome.storage.local.remove(MANUAL_PROFILE_KEY)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "cb-check-invites") {
    checkInvites(msg.businessIds || []).then(sendResponse);
    return true;
  }
  if (msg.type === "cb-report-invite") {
    reportInvite(msg.payload).then(sendResponse);
    return true;
  }
  return false;
});

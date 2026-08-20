// Tab controller. Talks to content/relay.js (in a business.facebook.com tab) for anything that
// needs the page's own Facebook session, and to background.js for anything that needs the Convite
// BM API or the AdsPower local API. Same MAIN/ISOLATED/extension split proven in
// I:\Manager Lite\extension\popup\popup.js, adapted from a popup to a full tab.

const els = {
  noContext: document.getElementById("viewNoContext"),
  main: document.getElementById("viewMain"),
  email: document.getElementById("fEmail"),
  profile: document.getElementById("fProfile"),
  total: document.getElementById("fTotal"),
  already: document.getElementById("fAlready"),
  rows: document.getElementById("rows"),
  toast: document.getElementById("toast"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnManualProfile: document.getElementById("btnManualProfile"),
  manualForm: document.getElementById("manualProfileForm"),
  manualProfileId: document.getElementById("manualProfileId"),
  manualSerialNumber: document.getElementById("manualSerialNumber"),
  btnManualSave: document.getElementById("btnManualSave"),
  btnManualCancel: document.getElementById("btnManualCancel"),
  btnManualRemove: document.getElementById("btnManualRemove"),
  chkAuto: document.getElementById("chkAuto"),
  btnSendAll: document.getElementById("btnSendAll"),
  btnStop: document.getElementById("btnStop"),
  progress: document.getElementById("progress"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),
};

const AUTO_STORAGE_KEY = "cbAutoOverride";
const CONSECUTIVE_FAILURE_LIMIT = 3;

let state = {};

function resetState() {
  state = {
    tabId: null,
    email: "",
    taskIds: [],
    autoEnabled: false,
    delayMs: 4000,
    profile: null,
    businesses: [],   // [{id, name, pictureUrl}]
    already: new Set(),
    rowStatus: new Map(), // id -> {status, detail, when, trigger}
    running: false,
    stopRequested: false,
    seedBusinessId: null,
  };
}
resetState();

// How often to re-list Business Managers while the tab stays open, so a BM created after the
// initial scan (or after a previous auto-run finished) still gets picked up without the user
// having to click "Atualizar". Cheap: one GraphQL call plus, only when something new turns up, one
// /invites/check call.
const RESCAN_INTERVAL_MS = 45000;
let rescanTimer = null;

// ── low-level messaging (same self-healing pattern as Manager Lite's popup.js) ─────────────────

function withTimeout(promise, ms, timeoutError) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ ok: false, error: timeoutError }); }
    }, ms);
    promise.then((r) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(r); }
    });
  });
}

function _sendToTabRaw(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: "sem resposta da página" });
      }
    });
  });
}

function _sendToBgRaw(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: "sem resposta da extensão" });
      }
    });
  });
}

const injectedTabs = new Set();

async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["lib/queries.js", "content/bridge.js"], world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["content/relay.js"], world: "ISOLATED",
    });
    return true;
  } catch (e) {
    return false;
  }
}

// The manifest only auto-injects content scripts into navigations that happen *after* the
// extension loads — a tab that was already open on business.facebook.com never gets them, and
// every message here would otherwise hang until timeout. Detect that one failure and self-heal.
async function sendToTab(tabId, msg, timeoutMs = 25000) {
  let resp = await withTimeout(_sendToTabRaw(tabId, msg), timeoutMs, "timeout aguardando resposta da página");
  const looksMissing = resp && resp.error &&
    /Receiving end does not exist|Could not establish connection/i.test(resp.error);
  if (looksMissing && !injectedTabs.has(tabId)) {
    injectedTabs.add(tabId);
    const injected = await injectContentScripts(tabId);
    if (injected) {
      await new Promise((r) => setTimeout(r, 300));
      resp = await withTimeout(_sendToTabRaw(tabId, msg), timeoutMs, "timeout aguardando resposta da página");
    }
  }
  return resp;
}

function sendToBg(msg, timeoutMs = 15000) {
  return withTimeout(_sendToBgRaw(msg), timeoutMs, "timeout aguardando resposta da extensão");
}

function showToast(msg, ok) {
  els.toast.textContent = msg;
  els.toast.className = "cb-toast " + (ok ? "ok" : "err");
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), 5000);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── finding / opening the Facebook tab ──────────────────────────────────────────────────────────

async function findOrOpenFbTab() {
  const tabs = await chrome.tabs.query({ url: "https://business.facebook.com/*" });
  if (tabs.length) return tabs[0].id;

  return new Promise((resolve) => {
    chrome.tabs.create(
      { url: "https://business.facebook.com/latest/settings/business_users", active: false },
      (tab) => resolve(tab ? tab.id : null),
    );
  });
}

async function waitForBusinessContext(tabId, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const resp = await sendToTab(tabId, { type: "cb-get-context" }, 5000);
    if (resp.ok && resp.context && resp.context.businessId) {
      return resp.context.businessId;
    }
    await sleep(500);
  }
  return null;
}

// ── data loading ─────────────────────────────────────────────────────────────────────────────

function extractBusinessScopes(data) {
  const scoping = data && data.viewer && data.viewer.meta_business_scoping;
  const scopes = scoping && scoping.business_scopes;
  if (!scopes) return { edges: [], hasNext: false, endCursor: null };
  const edges = (scopes.edges || []).map((e) => ({
    id: e.node.scope_id,
    name: e.node.scope_name || "",
    pictureUrl: (e.node.scope_profile_picture && e.node.scope_profile_picture.uri) || "",
  }));
  const pageInfo = scopes.page_info || {};
  return { edges, hasNext: !!pageInfo.has_next_page, endCursor: pageInfo.end_cursor || null };
}

async function listAllBusinesses(tabId, seedBusinessId) {
  const all = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const resp = await sendToTab(tabId, {
      type: "cb-run-query", key: "listBusinesses",
      ctx: { businessId: seedBusinessId, cursor },
    }, 20000);
    const result = resp.ok && resp.result;
    if (!result || !result.ok) {
      if (page === 0) throw new Error((result && JSON.stringify(result.err)) || "falha ao listar business managers");
      break;
    }
    const { edges, hasNext, endCursor } = extractBusinessScopes(result.data);
    for (const e of edges) {
      if (!seen.has(e.id)) { seen.add(e.id); all.push(e); }
    }
    if (!hasNext || !endCursor) break;
    cursor = endCursor;
  }
  return all;
}

async function detectProfile(force) {
  const resp = await sendToBg({ type: "cb-detect-profile", force: !!force });
  return resp.info || null;
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────

function statusBadge(row) {
  if (!row) return '<span class="cb-badge cb-badge-pending">pendente</span>';
  if (row.status === "running") return '<span class="cb-badge cb-badge-running">enviando…</span>';
  if (row.status === "sent") return '<span class="cb-badge cb-badge-sent">enviado</span>';
  if (row.status === "failed") return '<span class="cb-badge cb-badge-failed">falhou</span>';
  if (row.status === "skip") return '<span class="cb-badge cb-badge-skip">já convidado</span>';
  return '<span class="cb-badge cb-badge-pending">pendente</span>';
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderRows() {
  els.rows.innerHTML = state.businesses.map((b) => {
    const row = state.rowStatus.get(b.id);
    const trigBadge = row && row.trigger ? `<span class="cb-badge cb-badge-manual">${row.trigger === "auto" ? "auto" : "manual"}</span>` : "";
    const canSend = !row || row.status === "failed";
    const img = b.pictureUrl
      ? `<img class="cb-bm-pic" src="${escapeHtml(b.pictureUrl)}" alt="" />`
      : `<div class="cb-bm-pic"></div>`;
    return `
      <tr data-id="${escapeHtml(b.id)}">
        <td>${img}</td>
        <td class="cb-bm-name">${escapeHtml(b.name || "—")}</td>
        <td class="cb-mono">${escapeHtml(b.id)}</td>
        <td>${statusBadge(row)}${trigBadge}</td>
        <td class="cb-detail" title="${escapeHtml(row && row.detail)}">${escapeHtml((row && row.detail) || "—")}</td>
        <td class="cb-mono">${row && row.when ? new Date(row.when).toLocaleString("pt-BR") : "—"}</td>
        <td>
          <button class="cb-btn cb-btn-xs cb-btn-secondary" data-action="send" ${canSend ? "" : "disabled"}>
            ${row && row.status === "failed" ? "Reenviar" : "Enviar"}
          </button>
        </td>
      </tr>`;
  }).join("");
}

function updateSummary() {
  els.total.textContent = String(state.businesses.length);
  const alreadyCount = state.businesses.filter((b) => {
    const r = state.rowStatus.get(b.id);
    return state.already.has(b.id) || (r && r.status === "sent");
  }).length;
  els.already.textContent = String(alreadyCount);
}

function renderProfileRow() {
  if (state.profile && state.profile.profileId) {
    const manualTag = state.profile.manual ? " (manual)" : "";
    els.profile.textContent =
      `${state.profile.profileId}${state.profile.serialNumber ? " · nº " + state.profile.serialNumber : ""}${manualTag}`;
  } else {
    els.profile.textContent = "não detectado";
  }
}

function setProgress(current, total) {
  if (total <= 0) {
    els.progress.classList.add("hidden");
    return;
  }
  els.progress.classList.remove("hidden");
  els.progressFill.style.width = `${Math.round((current / total) * 100)}%`;
  els.progressLabel.textContent = `${current}/${total}`;
}

// ── error summarizing ────────────────────────────────────────────────────────────────────────
// Meta's GraphQL errors already carry a human (pt-BR) description — this maps the ones we've seen
// in practice to a short label for the table's Detalhe column, so a full server_error/field_exception
// JSON blob (mids, debug_link, stack of nested fields) never lands raw in the UI or the DB.

const FB_ERROR_LABELS = [
  { match: /não pode ser adicionad[oa]\s*à empresa/i, label: "BM restrita" },
  { match: /restrit[ao]/i, label: "BM restrita" },
  { match: /já (foi )?convidad|already.*invit|role.request.*already/i, label: "Já convidado" },
];

function summarizeFbError(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch (_) {
      return raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
    }
  }
  if (!Array.isArray(list)) list = [list];
  const first = (list && list[0]) || {};
  const text = String(first.description || first.summary || first.message || "").trim();
  if (text) {
    for (const { match, label } of FB_ERROR_LABELS) {
      if (match.test(text)) return label;
    }
    return text.length > 140 ? text.slice(0, 140) + "…" : text;
  }
  const fallback = JSON.stringify(raw);
  return fallback.length > 140 ? fallback.slice(0, 140) + "…" : fallback;
}

// ── invite flow ──────────────────────────────────────────────────────────────────────────────

function pendingBusinesses() {
  return state.businesses.filter((b) => {
    if (state.already.has(b.id)) return false;
    const r = state.rowStatus.get(b.id);
    return !r || r.status === "failed";
  });
}

async function inviteOne(business, trigger) {
  state.rowStatus.set(business.id, { status: "running", trigger });
  renderRows();

  const resp = await sendToTab(state.tabId, {
    type: "cb-run-query", key: "invite",
    ctx: { businessId: business.id, email: state.email, taskIds: state.taskIds },
  }, 25000);

  const result = resp.ok && resp.result;
  let payload = {
    business_id: business.id,
    business_name: business.name || "",
    business_picture_url: business.pictureUrl || "",
    trigger,
  };

  if (result && result.ok) {
    const requests = result.data &&
      result.data.business_settings_invite_business_users &&
      result.data.business_settings_invite_business_users.business_role_requests;
    const req = requests && requests[0];
    if (req) {
      payload.status = "sent";
      payload.role_request_id = req.id || "";
      payload.role_request_status = req.role_request_status || "";
      payload.expiration_time = req.expiration_time || null;
      payload.fb_actor_id = result.actorId || "";
    } else {
      payload.status = "failed";
      payload.error_message = "Resposta sem business_role_requests.";
    }
  } else {
    payload.status = "failed";
    const errRaw = (result && result.err) || (resp && resp.error) || "erro desconhecido";
    payload.error_message = summarizeFbError(errRaw);
  }

  if (state.profile) {
    payload.adspower_profile_id = state.profile.profileId || "";
    payload.adspower_serial = state.profile.serialNumber || "";
  }

  state.rowStatus.set(business.id, {
    status: payload.status,
    detail: payload.status === "sent" ? (payload.role_request_status || "PENDING") : payload.error_message,
    when: Date.now(),
    trigger,
  });
  if (payload.status === "sent") state.already.add(business.id);
  renderRows();
  updateSummary();

  await sendToBg({ type: "cb-report-invite", payload });
  return payload.status === "sent";
}

async function runScan(trigger) {
  if (state.running) return;
  state.running = true;
  state.stopRequested = false;
  els.btnStop.classList.remove("hidden");
  els.btnSendAll.disabled = true;

  const targets = pendingBusinesses();
  let consecutiveFailures = 0;
  let done = 0;
  setProgress(0, targets.length);

  for (const b of targets) {
    if (state.stopRequested) break;
    const ok = await inviteOne(b, trigger);
    done++;
    setProgress(done, targets.length);
    consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      showToast(`Parado após ${CONSECUTIVE_FAILURE_LIMIT} falhas seguidas.`, false);
      break;
    }
    if (done < targets.length && !state.stopRequested) {
      const jitter = Math.random() * 0.4 - 0.2; // ±20%
      await sleep(Math.max(500, state.delayMs * (1 + jitter)));
    }
  }

  state.running = false;
  els.btnStop.classList.add("hidden");
  els.btnSendAll.disabled = false;
  setProgress(0, 0);
  if (!state.stopRequested) showToast("Varredura concluída.", true);
}

// ── boot ─────────────────────────────────────────────────────────────────────────────────────

async function loadConfigAndProfile() {
  const [cfgResp, profile] = await Promise.all([
    sendToBg({ type: "cb-get-config" }),
    detectProfile(false),
  ]);

  if (!cfgResp || cfgResp.ok === false) {
    showToast((cfgResp && cfgResp.error) || "Não foi possível carregar a configuração.", false);
    return false;
  }

  state.email = cfgResp.email || "";
  state.taskIds = cfgResp.business_account_task_ids || [];
  state.autoEnabled = !!cfgResp.auto_invite_enabled;
  state.delayMs = cfgResp.invite_delay_ms || 4000;
  state.profile = profile;

  const override = await chrome.storage.local.get(AUTO_STORAGE_KEY);
  if (typeof override[AUTO_STORAGE_KEY] === "boolean") {
    state.autoEnabled = override[AUTO_STORAGE_KEY];
  }

  els.email.textContent = state.email || "não configurado";
  els.chkAuto.checked = state.autoEnabled;
  renderProfileRow();
  return true;
}

async function loadBusinessesAndAlready() {
  const seedId = await waitForBusinessContext(state.tabId);
  if (!seedId) {
    els.noContext.classList.remove("hidden");
    els.main.classList.add("hidden");
    return false;
  }
  state.seedBusinessId = seedId;

  const businesses = await listAllBusinesses(state.tabId, seedId);
  state.businesses = businesses;

  const idsResp = businesses.length
    ? await sendToBg({ type: "cb-check-invites", businessIds: businesses.map((b) => b.id) })
    : { ok: true, already: [] };
  state.already = new Set((idsResp && idsResp.already) || []);
  for (const id of state.already) {
    if (!state.rowStatus.has(id)) state.rowStatus.set(id, { status: "skip" });
  }

  renderRows();
  updateSummary();
  return true;
}

// Picks up Business Managers created (or newly visible) after the initial scan — e.g. the user
// creates a fresh BM while the tab is still open. Runs on a timer (see RESCAN_INTERVAL_MS) rather
// than only on manual refresh, since the whole point of auto-invite is not having to babysit it.
async function syncNewBusinesses() {
  if (!state.tabId || !state.seedBusinessId) return;

  let fresh;
  try {
    fresh = await listAllBusinesses(state.tabId, state.seedBusinessId);
  } catch (_) {
    return; // transient failure — next tick tries again, no need to surface a toast for this
  }

  const knownIds = new Set(state.businesses.map((b) => b.id));
  const newOnes = fresh.filter((b) => !knownIds.has(b.id));
  if (!newOnes.length) return;

  state.businesses = state.businesses.concat(newOnes);

  const idsResp = await sendToBg({ type: "cb-check-invites", businessIds: newOnes.map((b) => b.id) });
  for (const id of (idsResp && idsResp.already) || []) {
    state.already.add(id);
    state.rowStatus.set(id, { status: "skip" });
  }

  renderRows();
  updateSummary();
  showToast(`${newOnes.length} novo(s) Business Manager detectado(s).`, true);

  if (state.autoEnabled && !state.running && pendingBusinesses().length) {
    runScan("auto");
  }
}

function startRescanTimer() {
  if (rescanTimer) clearInterval(rescanTimer);
  rescanTimer = setInterval(syncNewBusinesses, RESCAN_INTERVAL_MS);
}

async function init() {
  if (rescanTimer) clearInterval(rescanTimer);
  resetState();
  els.noContext.classList.add("hidden");
  els.main.classList.add("hidden");

  const tabId = await findOrOpenFbTab();
  if (!tabId) {
    els.noContext.classList.remove("hidden");
    return;
  }
  state.tabId = tabId;

  const cfgOk = await loadConfigAndProfile();
  if (!cfgOk) return;

  els.main.classList.remove("hidden");
  const gotBusinesses = await loadBusinessesAndAlready();
  if (!gotBusinesses) return;

  startRescanTimer();

  if (state.autoEnabled && pendingBusinesses().length) {
    runScan("auto");
  }
}

// ── event wiring ─────────────────────────────────────────────────────────────────────────────

els.btnRefresh.addEventListener("click", init);

els.btnStop.addEventListener("click", () => { state.stopRequested = true; });

els.btnSendAll.addEventListener("click", () => runScan("manual"));

els.chkAuto.addEventListener("change", async () => {
  state.autoEnabled = els.chkAuto.checked;
  await chrome.storage.local.set({ [AUTO_STORAGE_KEY]: state.autoEnabled });
});

els.rows.addEventListener("click", async (ev) => {
  const btn = ev.target.closest('button[data-action="send"]');
  if (!btn) return;
  const tr = ev.target.closest("tr[data-id]");
  const id = tr && tr.getAttribute("data-id");
  const business = state.businesses.find((b) => b.id === id);
  if (!business) return;
  btn.disabled = true;
  await inviteOne(business, "manual");
});

els.btnManualProfile.addEventListener("click", () => {
  if (state.profile) {
    els.manualProfileId.value = state.profile.profileId || "";
    els.manualSerialNumber.value = state.profile.serialNumber || "";
  }
  els.manualForm.classList.toggle("hidden");
});

els.btnManualCancel.addEventListener("click", () => els.manualForm.classList.add("hidden"));

els.btnManualSave.addEventListener("click", async () => {
  const profileId = els.manualProfileId.value.trim();
  if (!profileId) { showToast("Informe o ID do perfil.", false); return; }
  const resp = await sendToBg({
    type: "cb-set-manual-profile", profileId, serialNumber: els.manualSerialNumber.value.trim(),
  });
  if (resp.ok) {
    state.profile = resp.info;
    renderProfileRow();
    els.manualForm.classList.add("hidden");
    showToast("Perfil salvo para este navegador.", true);
  } else {
    showToast(resp.error || "Falha ao salvar.", false);
  }
});

els.btnManualRemove.addEventListener("click", async () => {
  await sendToBg({ type: "cb-clear-manual-profile" });
  els.manualForm.classList.add("hidden");
  state.profile = await detectProfile(true);
  renderProfileRow();
  showToast("Perfil manual removido.", true);
});

init();

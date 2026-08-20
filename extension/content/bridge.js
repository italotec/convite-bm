// MAIN-world bridge: reads the page's own session tokens (fb_dtsg/lsd/c_user) and fires the
// internal GraphQL queries listed in lib/queries.js. Ported from
// I:\Manager Lite\extension\content\bridge.js (same technique, same MAIN/ISOLATED split). Talks to
// content/relay.js (ISOLATED world) exclusively via window.postMessage — MAIN and ISOLATED do not
// share a JS global.
(function () {
  const MSG_TO_BRIDGE = "cb-relay";
  const MSG_FROM_BRIDGE = "cb-bridge";

  function getSessionTokens() {
    let dtsg = "", lsd = "", uid = "";
    try { dtsg = require("DTSGInitialData").token; } catch (_) {}
    try { lsd = require("LSD").token; } catch (_) {}
    try { uid = require("CurrentUserInitialData").USER_ID; } catch (_) {}
    if (!dtsg) {
      const inp = document.querySelector('input[name="fb_dtsg"]');
      if (inp) dtsg = inp.value;
    }
    if (!dtsg || !lsd) {
      const html = document.documentElement.innerHTML;
      if (!dtsg) {
        const m = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
        if (m) dtsg = m[1];
      }
      if (!lsd) {
        const m = html.match(/"LSD",\[\],\{"token":"([^"]+)"/);
        if (m) lsd = m[1];
      }
    }
    if (!uid) {
      const m = document.cookie.match(/c_user=(\d+)/);
      if (m) uid = m[1];
    }
    return { dtsg, lsd, uid };
  }

  function jazoestFor(dtsg) {
    const charSum = Array.from(dtsg).reduce((s, c) => s + c.charCodeAt(0), 0);
    return "2" + (charSum + 50);
  }

  // Best-effort runtime doc_id lookup, survives Meta rotating a doc_id without a code change.
  // Unverified against a live session — treated as an optimistic override of the HAR-captured
  // constant, same caveat as Manager Lite's bridge.js:resolveDocId.
  function resolveDocId(queryName, fallbackDocId) {
    try {
      const mod = require(`${queryName}_facebookRelayOperation`);
      if (mod && typeof mod === "string") return mod;
      if (mod && mod.id) return mod.id;
    } catch (_) {}
    return fallbackDocId;
  }

  function currentBusinessId() {
    const url = new URL(window.location.href);
    return url.searchParams.get("business_id") || url.searchParams.get("global_scope_id");
  }

  // Deferred GraphQL responses can arrive as multiple newline-delimited JSON objects (an
  // is_final:false chunk followed by one or more $defer chunks) — parse each line and deep-merge
  // onto one `data` object. Ported verbatim from Manager Lite's bridge.js.
  function parseMultiPayload(text) {
    const merged = { data: {} };
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.errors) merged.errors = (merged.errors || []).concat(obj.errors);
      if (obj.path && obj.data) {
        setAtPath(merged.data, obj.path, obj.data);
      } else if (obj.data) {
        deepMerge(merged.data, obj.data);
      }
    }
    return merged;
  }

  function deepMerge(target, src) {
    for (const k of Object.keys(src || {})) {
      const sv = src[k];
      if (sv && typeof sv === "object" && !Array.isArray(sv) &&
          target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) {
        deepMerge(target[k], sv);
      } else {
        target[k] = sv;
      }
    }
    return target;
  }

  function setAtPath(root, path, data) {
    let node = root;
    for (let i = 0; i < path.length; i++) {
      const key = path[i];
      if (i === path.length - 1) {
        node[key] = node[key] && typeof node[key] === "object" ? deepMerge(node[key], data) : data;
      } else {
        if (!node[key] || typeof node[key] !== "object") node[key] = {};
        node = node[key];
      }
    }
  }

  async function fireQuery(key, ctx) {
    const def = (window.__CB_QUERIES__ && window.__CB_QUERIES__.queries || {})[key];
    if (!def) return { key, ok: false, err: `unknown query ${key}` };

    const { dtsg, lsd, uid } = getSessionTokens();
    if (!dtsg || !lsd || !uid) {
      return { key, ok: false, err: "session tokens missing (dtsg/lsd/uid) — recarregue a página" };
    }
    const docId = resolveDocId(def.name, def.docId);
    const variables = JSON.stringify(def.vars(Object.assign({ actorId: uid }, ctx)));
    const body = new URLSearchParams({
      av: uid, __user: uid, __a: "1", fb_dtsg: dtsg, jazoest: jazoestFor(dtsg), lsd,
      __comet_req: "15", fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: def.name, server_timestamps: "true", variables, doc_id: docId,
    });
    try {
      const resp = await fetch("/api/graphql/", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-lsd": lsd,
          "x-fb-friendly-name": def.name,
        },
        body: body.toString(),
      });
      const text = await resp.text();
      const parsed = parseMultiPayload(text);
      if (parsed.errors && parsed.errors.length) {
        return { key, ok: false, err: parsed.errors, status: resp.status };
      }
      return { key, ok: true, data: parsed.data, status: resp.status, actorId: uid };
    } catch (e) {
      return { key, ok: false, err: e.toString() };
    }
  }

  function postToRelay(type, payload) {
    window.postMessage(Object.assign({ source: MSG_FROM_BRIDGE, type }, payload), "*");
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_TO_BRIDGE) return;

    if (data.type === "runQuery") {
      const result = await fireQuery(data.key, data.ctx || {});
      postToRelay("queryResult", { reqId: data.reqId, result });
    } else if (data.type === "requestContext") {
      postToRelay("context", { context: { businessId: currentBusinessId() } });
    }
  });

  // Comet is a client-routed SPA — there is no full page load between BMs, so poll the URL rather
  // than relying on 'popstate' (same approach as Manager Lite's bridge.js:pollContext).
  let lastCtxKey = "";
  function pollContext() {
    const ctx = { businessId: currentBusinessId() };
    const key = `${ctx.businessId}`;
    if (key !== lastCtxKey) {
      lastCtxKey = key;
      postToRelay("context", { context: ctx });
    }
  }
  setInterval(pollContext, 1000);
  pollContext();
})();

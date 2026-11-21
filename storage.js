/* Quilt Studio storage
   - Saves everything in this browser with IndexedDB (falls back to localStorage if IndexedDB is unavailable).
   - Backup / restore to a .json file.
   - Optional sync to the user's own Google Drive (hidden app folder, drive.appdata scope).
   Exposes window.QSStore = { store, ready, downloadText } and fires "qs:datachange" on window
   when records change from outside the current page (sync or restore). */
(() => {
"use strict";

const CFG = window.QS_CONFIG || {};
const KINDS = ["designs", "quilts", "stash", "projects", "wips", "notions", "yarn", "hooks"];
const LS = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch {} },
  del(k){ try { localStorage.removeItem(k); } catch {} }
};
const keyOf = (kind, id) => kind + "/" + id;
let lastMt = 0;
const nextMt = () => (lastMt = Math.max(Date.now(), lastMt + 1));
const emitChange = () => window.dispatchEvent(new CustomEvent("qs:datachange"));

/* =================================================================
   Backends. A record looks like:
   { key, kind, id, data, mt, del, fileId }
   mt = last-modified time (ms), del = 1 for a deleted record (kept so the deletion syncs),
   fileId = the matching file in Google Drive, once synced.
   ================================================================= */
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function idbBackend(){
  const open = new Promise((res, rej) => {
    const r = indexedDB.open("quilt-studio", 1);
    r.onupgradeneeded = () => {
      const os = r.result.createObjectStore("records", { keyPath: "key" });
      os.createIndex("kind", "kind");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("Storage is blocked by another open tab."));
  });
  const os = (db, mode) => db.transaction("records", mode).objectStore("records");
  const done = t => new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("Couldn’t save — browser storage may be full."));
  });
  return {
    name: "indexeddb",
    open,
    async all(kind){ const db = await open; const s = os(db, "readonly"); return req2p(kind ? s.index("kind").getAll(kind) : s.getAll()); },
    async putMany(recs){
      if (!recs.length) return;
      const db = await open; const t = db.transaction("records", "readwrite"); const s = t.objectStore("records");
      recs.forEach(r => s.put(r));
      return done(t);
    },
    /* Read-modify-write inside one transaction, so a sync never overwrites an edit made meanwhile.
       fn(existing, incoming) returns the record to store, or null to skip. Resolves to the number written. */
    async mergeMany(recs, fn){
      if (!recs.length) return 0;
      const db = await open; const t = db.transaction("records", "readwrite"); const s = t.objectStore("records");
      let n = 0;
      recs.forEach(inc => { const g = s.get(inc.key); g.onsuccess = () => { const out = fn(g.result, inc); if (out){ s.put(out); n++; } }; });
      await done(t);
      return n;
    }
  };
}

function lsBackend(){
  const K = "qs:records";
  let map;
  const load = () => { if (!map){ try { map = new Map(Object.entries(JSON.parse(LS.get(K) || "{}"))); } catch { map = new Map(); } } return map; };
  const persist = () => { try { localStorage.setItem(K, JSON.stringify(Object.fromEntries(load()))); } catch { throw new Error("Browser storage is full or unavailable."); } };
  return {
    name: "localstorage",
    open: Promise.resolve(),
    async all(kind){ return [...load().values()].filter(r => !kind || r.kind === kind).map(r => structuredClone(r)); },
    async putMany(recs){ recs.forEach(r => load().set(r.key, structuredClone(r))); persist(); },
    async mergeMany(recs, fn){ let n = 0; recs.forEach(inc => { const out = fn(load().get(inc.key), inc); if (out){ load().set(out.key, structuredClone(out)); n++; } }); persist(); return n; }
  };
}

let B;
async function pickBackend(){
  if (window.indexedDB){
    try { const b = idbBackend(); await b.open; B = b; return; } catch (e) { console.warn("IndexedDB unavailable, using localStorage", e); }
  }
  B = lsBackend();
}

/* One-time copy of data saved by the original version of the app (localStorage "qs:<kind>" arrays).
   The old keys are left in place as a safety net. */
async function migrate(){
  if (LS.get("qs:migrated")) return;
  const existing = new Set((await B.all()).map(r => r.key));
  const recs = [];
  for (const kind of KINDS){
    let arr; try { arr = JSON.parse(LS.get("qs:" + kind) || "[]"); } catch { arr = []; }
    if (!Array.isArray(arr)) continue;
    for (const o of arr){
      if (!o || o.id == null) continue;
      const id = String(o.id), { id: _drop, ...data } = o;
      if (!existing.has(keyOf(kind, id))) recs.push({ key: keyOf(kind, id), kind, id, data, mt: +o.updated || Date.now(), del: 0 });
    }
  }
  await B.putMany(recs);
  LS.set("qs:migrated", "1");
}

const ready = (async () => { await pickBackend(); await migrate(); })();

/* =================================================================
   Store API used by the app (same shape as the original)
   ================================================================= */
let askedPersist = false;
function askPersist(){
  if (askedPersist) return; askedPersist = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}
}

async function writeLocal(kind, id, data, del){
  await ready;
  id = String(id);
  const mt = nextMt();
  // keep the Drive fileId when overwriting
  await B.mergeMany([{ key: keyOf(kind, id) }], ex => ({ key: keyOf(kind, id), kind, id, data, mt, del, fileId: ex?.fileId || null }));
  askPersist();
  Sync.schedule();
  UI.render();
}

const store = {
  async list(kind){
    await ready;
    return (await B.all(kind)).filter(r => !r.del).map(r => ({ id: r.id, ...r.data }))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  },
  async save(kind, id, obj){
    const data = { ...(obj || {}) }; delete data.id;
    await writeLocal(kind, id, data, 0);
  },
  async remove(kind, id){ await writeLocal(kind, id, null, 1); }
};

/* =================================================================
   Backup / restore
   ================================================================= */
function downloadText(filename, text, type = "text/plain"){
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportBackup(){
  await ready;
  const recs = (await B.all()).filter(r => !r.del);
  let current = null; try { current = JSON.parse(LS.get("qs:current") || "null"); } catch {}
  const payload = { app: "quilt-studio", format: 1, exportedAt: new Date().toISOString(),
    records: recs.map(r => ({ kind: r.kind, id: r.id, mt: r.mt, data: r.data })), current };
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  downloadText(`quilt-studio-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`, JSON.stringify(payload), "application/json");
  LS.set("qs:lastBackup", String(Date.now()));
  UI.render();
  return recs.length;
}

async function importBackup(file){
  await ready;
  let p; try { p = JSON.parse(await file.text()); } catch { throw new Error("That file isn’t a Quilt Studio backup."); }
  if (!p || p.app !== "quilt-studio" || !Array.isArray(p.records)) throw new Error("That file isn’t a Quilt Studio backup.");
  const incoming = p.records
    .filter(r => r && KINDS.includes(r.kind) && r.id != null && r.data && typeof r.data === "object")
    .map(r => ({ key: keyOf(r.kind, String(r.id)), kind: r.kind, id: String(r.id), data: r.data, mt: +r.mt || 0, del: 0 }));
  let added = 0, updated = 0;
  await B.mergeMany(incoming, (ex, inc) => {
    if (!ex){ added++; return { ...inc, mt: inc.mt || nextMt(), fileId: null }; }
    // a record deleted here comes back (restoring is a deliberate choice); otherwise newer wins
    if (ex.del){ added++; return { ...inc, mt: nextMt(), fileId: ex.fileId || null }; }
    if (inc.mt > ex.mt){ updated++; return { ...inc, fileId: ex.fileId || null }; }
    return null;
  });
  if (p.current && p.current.cells && !LS.get("qs:current")) LS.set("qs:current", JSON.stringify(p.current));
  emitChange();
  Sync.schedule(300);
  UI.render();
  return { added, updated, total: incoming.length };
}

/* =================================================================
   Google Drive sync (appDataFolder, one small JSON file per record)
   ================================================================= */
const Sync = (() => {
  const enabledCfg = !!CFG.googleClientId;
  const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.appdata";
  const SCOPES = SCOPE_DRIVE + " openid email";
  const API = "https://www.googleapis.com/drive/v3/files";
  const UP = "https://www.googleapis.com/upload/drive/v3/files";
  let token = null, tokenExp = 0, tokenClient = null, pending = null;
  let state = "off", errMsg = "", busy = false, again = false, timer = null;

  // restore a still-valid token from earlier in the hour
  try { const t = JSON.parse(LS.get("qs:gToken") || "null"); if (t && t.exp > Date.now() + 60000){ token = t.t; tokenExp = t.exp; } } catch {}
  const signedIn = () => LS.get("qs:gSync") === "1";
  const account = () => LS.get("qs:gAccount") || "";
  const haveToken = () => token && Date.now() < tokenExp - 60000;

  function initGis(){
    if (!enabledCfg) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId, scope: SCOPES,
        callback: r => {
          const p = pending; pending = null; if (!p) return;
          if (r.error) return p.rej(new Error(r.error_description || r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE_DRIVE))
            return p.rej(new Error("Quilt Studio needs permission to keep its data in your Google Drive. Try again and leave that box checked."));
          token = r.access_token; tokenExp = Date.now() + (+r.expires_in || 3600) * 1000;
          LS.set("qs:gToken", JSON.stringify({ t: token, exp: tokenExp }));
          p.res(token);
        },
        error_callback: e => { const p = pending; pending = null; p && p.rej(new Error(e?.type === "popup_closed" ? "Sign-in was closed before it finished." : e?.type === "popup_failed_to_open" ? "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again." : "Google sign-in didn’t finish.")); }
      });
      UI.render();
    };
    s.onerror = () => { state = "error"; errMsg = "Couldn’t load Google sign-in. Check your connection."; UI.render(); };
    document.head.appendChild(s);
  }

  // Must be called straight from a click so the browser allows the Google window.
  function requestToken(){
    if (!tokenClient) return Promise.reject(new Error("Google sign-in is still loading. Try again in a moment."));
    return new Promise((res, rej) => {
      pending = { res, rej };
      tokenClient.requestAccessToken({ prompt: signedIn() ? "" : "consent", login_hint: account() || undefined });
    });
  }

  async function api(url, opts = {}, tries = 3){
    for (let i = 0; ; i++){
      const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
      if (r.ok) return r;
      if (r.status === 401){ token = null; LS.del("qs:gToken"); throw Object.assign(new Error("Sign-in expired"), { code: "auth" }); }
      if ((r.status === 429 || r.status >= 500 || r.status === 403) && i < tries - 1){ await new Promise(s => setTimeout(s, 800 * 2 ** i + Math.random() * 300)); continue; }
      throw Object.assign(new Error("Google Drive error " + r.status), { status: r.status });
    }
  }

  async function listRemote(){
    const out = new Map(), extras = [];
    let pt = "";
    do {
      const u = new URL(API);
      u.searchParams.set("spaces", "appDataFolder");
      u.searchParams.set("pageSize", "1000");
      u.searchParams.set("fields", "nextPageToken,files(id,appProperties)");
      if (pt) u.searchParams.set("pageToken", pt);
      const j = await (await api(u)).json();
      for (const f of j.files || []){
        const p = f.appProperties || {};
        if (!KINDS.includes(p.k) || !p.i) continue;
        const key = keyOf(p.k, p.i), rec = { fileId: f.id, mt: +p.mt || 0, del: p.d === "1" };
        const prev = out.get(key);
        if (!prev || rec.mt > prev.mt){ if (prev) extras.push(prev.fileId); out.set(key, rec); }
        else extras.push(f.id); // duplicate created by two devices at once; the newest wins
      }
      pt = j.nextPageToken;
    } while (pt);
    return { remote: out, extras };
  }

  async function upload(rec){
    const meta = { appProperties: { k: rec.kind, i: rec.id, mt: String(rec.mt), d: rec.del ? "1" : "0" } };
    const body = JSON.stringify({ kind: rec.kind, id: rec.id, mt: rec.mt, del: rec.del ? 1 : 0, data: rec.del ? null : rec.data });
    const send = async fileId => {
      const m = fileId ? meta : { ...meta, name: `${rec.kind}-${rec.id}.json`, parents: ["appDataFolder"] };
      const b = "qs" + Math.random().toString(36).slice(2);
      const mp = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(m)}\r\n--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${b}--`;
      const r = await api(fileId ? `${UP}/${fileId}?uploadType=multipart&fields=id` : `${UP}?uploadType=multipart&fields=id`,
        { method: fileId ? "PATCH" : "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body: mp });
      return (await r.json()).id;
    };
    try { return await send(rec.fileId); }
    catch (e) { if (rec.fileId && e.status === 404) return send(null); throw e; } // file was removed from Drive: recreate
  }

  async function pool(items, n, fn){
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
  }

  async function run(){
    if (!enabledCfg || !signedIn()) return;
    if (busy){ again = true; return; }
    if (!haveToken()){ state = "reconnect"; UI.render(); return; }
    if (!navigator.onLine){ state = "offline"; UI.render(); return; }
    busy = true; state = "syncing"; UI.render();
    try {
      await ready;
      const { remote, extras } = await listRemote();
      const local = new Map((await B.all()).map(r => [r.key, r]));
      const down = [], up = [], links = [];
      for (const [key, rm] of remote){
        const lc = local.get(key);
        if (!lc || rm.mt > lc.mt) down.push([key, rm]);
        else if (lc.mt > rm.mt) up.push({ ...lc, fileId: rm.fileId });
        else if (lc.fileId !== rm.fileId) links.push({ key, fileId: rm.fileId });
      }
      for (const [key, lc] of local){
        if (remote.has(key)) continue;
        if (lc.del && !lc.fileId) continue; // deleted before it ever reached Drive
        up.push({ ...lc, fileId: null });
      }

      // pull newer records from Drive
      const pulled = [];
      await pool(down, 4, async ([key, rm]) => {
        const [kind, ...rest] = key.split("/"), id = rest.join("/");
        if (rm.del){ pulled.push({ key, kind, id, data: null, mt: rm.mt, del: 1, fileId: rm.fileId }); return; }
        const j = await (await api(`${API}/${rm.fileId}?alt=media`)).json();
        pulled.push({ key, kind, id, data: j.data || {}, mt: rm.mt, del: 0, fileId: rm.fileId });
      });
      const applied = await B.mergeMany(pulled, (ex, inc) => (!ex || inc.mt > ex.mt) ? inc : null);

      // push newer local records to Drive
      const pushed = [];
      await pool(up, 3, async rec => { pushed.push({ key: rec.key, fileId: await upload(rec) }); });
      await B.mergeMany([...pushed, ...links], (ex, inc) => ex && ex.fileId !== inc.fileId ? { ...ex, fileId: inc.fileId } : null);

      // tidy up duplicate files (best effort)
      extras.forEach(id => api(`${API}/${id}`, { method: "DELETE" }, 1).catch(() => {}));

      if (applied) emitChange();
      LS.set("qs:lastSync", String(Date.now()));
      state = "ok"; errMsg = "";
    } catch (e) {
      if (e.code === "auth") state = "reconnect";
      else { state = navigator.onLine ? "error" : "offline"; errMsg = e.message || "Something went wrong."; console.warn("Drive sync failed", e); }
    } finally {
      busy = false; UI.render();
      if (again){ again = false; schedule(500); }
    }
  }

  function schedule(ms = 2500){
    if (!enabledCfg || !signedIn()) return;
    clearTimeout(timer); timer = setTimeout(run, ms);
  }

  async function signIn(){
    // called from a click
    const t = requestToken();
    await t;
    let email = "";
    try { email = (await (await api("https://www.googleapis.com/oauth2/v3/userinfo")).json()).email || ""; } catch {}
    const prev = account();
    if (prev && email && prev !== email &&
        !confirm(`This browser was last synced with ${prev}. Merge everything saved here into ${email}’s Google Drive too?`)){
      try { google.accounts.oauth2.revoke(token, () => {}); } catch {}
      token = null; LS.del("qs:gToken"); return;
    }
    if (email) LS.set("qs:gAccount", email);
    LS.set("qs:gSync", "1");
    askPersist();
    await run();
  }

  async function reconnect(){ await requestToken(); await run(); }

  function signOut(){
    try { if (token) google.accounts.oauth2.revoke(token, () => {}); } catch {}
    token = null; LS.del("qs:gToken"); LS.del("qs:gSync"); state = "off"; UI.render();
  }

  // background triggers
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(400); });
  window.addEventListener("online", () => schedule(400));
  setInterval(() => { if (document.visibilityState === "visible") run(); }, 5 * 60 * 1000);

  return { enabledCfg, initGis, schedule, run, signIn, reconnect, signOut,
    get state(){ return signedIn() ? (state === "off" ? (haveToken() ? "ok" : "reconnect") : state) : "off"; },
    get error(){ return errMsg; }, account, ready: () => !!tokenClient };
})();

/* =================================================================
   UI: a small bar in the header
   ================================================================= */
const UI = (() => {
  let el;
  const ago = ms => {
    if (!ms) return "never";
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " hr ago";
    const d = Math.round(s / 86400); return d === 1 ? "yesterday" : d < 14 ? d + " days ago" : Math.round(d / 7) + " weeks ago";
  };
  const say = msg => { const t = document.getElementById("toast"); if (!t) return alert(msg); t.textContent = msg; t.classList.add("show"); clearTimeout(say._t); say._t = setTimeout(() => t.classList.remove("show"), 3200); };
  const guard = fn => async e => { e?.preventDefault?.(); try { await fn(); } catch (err) { say(err.message || "Something went wrong."); UI.render(); } };

  function render(){
    if (!el) return;
    const st = Sync.state, lastB = +LS.get("qs:lastBackup") || 0, lastS = +LS.get("qs:lastSync") || 0;
    let text, cls = "", btns = [];
    if (st === "off"){
      const stale = Date.now() - lastB > 30 * 864e5;
      text = `Saved in this browser · last backup ${ago(lastB)}`;
      if (stale) cls = "warn";
      if (Sync.enabledCfg) btns.push(["Sync with Google Drive", "signin", true]);
    } else if (st === "syncing"){ text = "Syncing with Google Drive…"; }
    else if (st === "ok"){ text = `Synced to Google Drive${Sync.account() ? " (" + Sync.account() + ")" : ""} · ${ago(lastS)}`; btns.push(["Sync now", "sync"]); }
    else if (st === "reconnect"){ text = "Drive sync paused — Google sign-in expired"; cls = "warn"; btns.push(["Reconnect", "reconnect", true]); }
    else if (st === "offline"){ text = "Offline — changes are saved here and will sync later"; }
    else { text = "Couldn’t sync: " + Sync.error; cls = "warn"; btns.push(["Try again", "sync"]); }
    btns.push(["Back up", "export"], ["Restore", "import"]);
    if (st !== "off") btns.push(["Sign out", "signout"]);
    el.innerHTML = `<span class="sync-text ${cls}">${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span>` +
      btns.map(([label, act, primary]) => `<button type="button" class="btn small${primary ? " primary" : ""}" data-act="${act}">${label}</button>`).join("") +
      `<input type="file" accept="application/json,.json" hidden>`;
    const file = el.querySelector("input[type=file]");
    el.querySelectorAll("button[data-act]").forEach(b => {
      const a = b.dataset.act;
      if (a === "signin") b.onclick = guard(Sync.signIn);
      if (a === "reconnect") b.onclick = guard(Sync.reconnect);
      if (a === "sync") b.onclick = guard(Sync.run);
      if (a === "signout") b.onclick = () => { if (confirm("Stop syncing this browser with Google Drive? Everything stays saved here and in your Drive.")) Sync.signOut(); };
      if (a === "export") b.onclick = guard(async () => { const n = await exportBackup(); say(`Backup downloaded (${n} items).`); });
      if (a === "import") b.onclick = () => file.click();
    });
    file.onchange = guard(async () => {
      const f = file.files[0]; if (!f) return;
      const r = await importBackup(f);
      say(r.added || r.updated ? `Restored ${r.added} new and ${r.updated} updated items.` : "Everything in that backup is already here.");
    });
  }

  function mount(){
    el = document.getElementById("syncBar");
    render();
    setInterval(render, 60 * 1000); // keep "x min ago" fresh
  }
  return { render, mount };
})();

function boot(){ UI.mount(); Sync.initGis(); ready.then(() => Sync.schedule(800)); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

window.QSStore = { store, ready, downloadText, exportBackup, importBackup, _sync: Sync, _backend: () => B };
})();

/* تنافس — hosted backend adapter (Supabase).
   Re-implements the three capabilities the site used on claude.ai, with the same API:
     db   : doc(path).get/set/delete, collection(name).get        -> table public.docs
     user : canEdit()                                              -> owner signed in with Supabase Auth (role admin)
     room : emit/on/presence/peers/onPeers                         -> one Supabase Realtime channel
   Plus org login without exposing password hashes: TN.login / TN.profile (RPCs).
   Needs window.TN_CONFIG = {url, key} and supabase-js loaded first. */
(function(){
  const cfg = window.TN_CONFIG || {};
  if (!cfg.url || !cfg.key || !window.supabase) return;       // no backend -> site runs in standalone mode
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, storageKey: "tn-owner" } });

  const split = p => { const i = p.indexOf("/"); return [p.slice(0, i), p.slice(i + 1)]; };
  const snap = (id, row) => ({ id, exists: !!row, data: () => row ? row.data : undefined });
  const fail = e => { const x = new Error(e && e.message || "db error"); x.code = e && e.code; throw x; };

  const db = {
    doc(path){
      const [col, id] = split(path);
      return {
        id,
        async get(){ const { data, error } = await sb.from("docs").select("data").eq("col", col).eq("id", id).maybeSingle(); if (error) fail(error); return snap(id, data); },
        async set(obj){ const { error } = await sb.from("docs").upsert({ col, id, data: obj, updated: new Date().toISOString() }); if (error) fail(error); },
        async delete(){ const { error } = await sb.from("docs").delete().eq("col", col).eq("id", id); if (error) fail(error); }
      };
    },
    collection(col){
      return {
        async get(){
          const rows = []; const page = 500;
          for (let from = 0; ; from += page){
            const { data, error } = await sb.from("docs").select("id,data").eq("col", col).order("id").range(from, from + page - 1);
            if (error) fail(error); rows.push(...data); if (data.length < page) break;
          }
          const docs = rows.map(r => ({ id: r.id, exists: true, data: () => r.data }));
          return { empty: !docs.length, docs, size: docs.length };
        }
      };
    }
  };

  async function isAdmin(){
    const { data } = await sb.auth.getSession(); const s = data && data.session;
    return !!(s && s.user && s.user.app_metadata && s.user.app_metadata.role === "admin");
  }
  const user = { canEdit: isAdmin };

  /* ---------- realtime room ---------- */
  let room = null;
  function makeRoom(){
    const me = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    const ch = sb.channel("tanafus-live", { config: { broadcast: { self: false, ack: false }, presence: { key: me } } });
    const handlers = {}, peerSubs = new Set();
    let mine = {}, prev = {}, ready, readyRes;
    ready = new Promise(r => readyRes = r);
    const flat = () => { const st = ch.presenceState(), out = {};
      Object.keys(st).forEach(k => { const metas = st[k]; if (metas && metas.length) out[k] = metas[metas.length - 1].p || {}; }); return out; };
    const peerOf = (k, p) => ({ peer: k, presence: p, sameTab: k === me });
    ch.on("broadcast", { event: "m" }, ({ payload }) => {
      const t = payload && payload.t; (handlers[t] || []).forEach(fn => { try { fn({ type: t, data: payload.d, peer: payload.f, sameTab: false }); } catch(e){} });
    });
    ch.on("presence", { event: "sync" }, () => {
      const now = flat(), joined = [], updated = [], left = [];
      Object.keys(now).forEach(k => { if (!(k in prev)) joined.push(peerOf(k, now[k])); else if (JSON.stringify(prev[k]) !== JSON.stringify(now[k])) updated.push(peerOf(k, now[k])); });
      Object.keys(prev).forEach(k => { if (!(k in now)) left.push(peerOf(k, prev[k])); });
      prev = now;
      if (joined.length || updated.length || left.length) peerSubs.forEach(fn => { try { fn({ joined, updated, left }); } catch(e){} });
    });
    ch.subscribe(status => { if (status === "SUBSCRIBED"){ ch.track({ p: mine }); readyRes(); } });
    return {
      async emit(type, data){ await ready; const r = await ch.send({ type: "broadcast", event: "m", payload: { t: type, d: data, f: me } }); if (r !== "ok") throw new Error("emit " + r); },
      on(type, fn){ (handlers[type] = handlers[type] || []).push(fn); return () => { handlers[type] = (handlers[type] || []).filter(x => x !== fn); }; },
      async presence(obj){
        Object.keys(obj || {}).forEach(k => { if (obj[k] === null) delete mine[k]; else mine[k] = obj[k]; });
        await ready; await ch.track({ p: mine });
      },
      peers(){ const now = flat(); if (!(me in now)) now[me] = mine; return Object.keys(now).map(k => peerOf(k, now[k])); },
      onPeers(fn){ peerSubs.add(fn); return () => peerSubs.delete(fn); }
    };
  }

  window.TN = {
    client: sb,
    async use(name){
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "room") return room || (room = makeRoom());
      return null;                       // downloads etc. -> the site falls back to normal browser behaviour
    },
    isAdmin,
    /* org login: the server checks the password, the hash never reaches the browser */
    async login(u, pw){ const { data, error } = await sb.rpc("tn_login", { p_user: u, p_pw: pw }); if (error) throw error; return data || null; },
    async profile(u){ const { data, error } = await sb.rpc("tn_profile", { p_user: u }); if (error) return null; return data || null; },
    /* owner login (email + password, Supabase Auth) */
    async ownerLogin(email, pw){ const { error } = await sb.auth.signInWithPassword({ email, password: pw }); if (error) return false; return await isAdmin(); },
    async ownerLogout(){ await sb.auth.signOut(); }
  };
})();

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

  /* ---------- realtime room ----------
     Supabase Presence is rate-limited per client (a phone tapping fast got cut off), so presence is
     carried on broadcast instead: each tab announces its state (throttled), re-announces every 4 s as
     a heartbeat, and is dropped after 12 s of silence or on "bye". */
  let room = null;
  function makeRoom(){
    const me = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    const ch = sb.channel("tanafus-live", { config: { broadcast: { self: false, ack: false } } });
    const handlers = {}, peerSubs = new Set(), others = {};      // others: key -> {p, t}
    let mine = {}, ready, readyRes, joined = false, lastSent = 0, pend = null;
    ready = new Promise(r => readyRes = r);
    const THROTTLE = 450, BEAT = 4000, EXPIRE = 12000;
    const peerOf = (k, p) => ({ peer: k, presence: p, sameTab: k === me });
    const notify = ch2 => { if (ch2.joined.length || ch2.updated.length || ch2.left.length) peerSubs.forEach(fn => { try { fn(ch2); } catch(e){} }); };
    const raw = (event, payload) => ch.send({ type: "broadcast", event, payload });
    const announce = () => { lastSent = Date.now(); pend = null; return raw("p", { f: me, p: mine }); };
    const schedule = () => {                                       // leading + trailing throttle
      if (!joined) return; const wait = THROTTLE - (Date.now() - lastSent);
      if (wait <= 0 && !pend) return announce();
      if (!pend) pend = setTimeout(announce, Math.max(0, wait));
    };
    ch.on("broadcast", { event: "m" }, ({ payload }) => {
      const t = payload && payload.t; (handlers[t] || []).forEach(fn => { try { fn({ type: t, data: payload.d, peer: payload.f, sameTab: false }); } catch(e){} });
    });
    ch.on("broadcast", { event: "p" }, ({ payload }) => {
      if (!payload || !payload.f || payload.f === me) return;
      const k = payload.f, old = others[k], p = payload.p || {};
      others[k] = { p, t: Date.now() };
      if (!old) notify({ joined: [peerOf(k, p)], updated: [], left: [] });
      else if (JSON.stringify(old.p) !== JSON.stringify(p)) notify({ joined: [], updated: [peerOf(k, p)], left: [] });
    });
    ch.on("broadcast", { event: "hello" }, ({ payload }) => { if (payload && payload.f !== me) setTimeout(announce, Math.random() * 600); });
    ch.on("broadcast", { event: "bye" }, ({ payload }) => {
      const k = payload && payload.f; if (!k || !others[k]) return; const o = others[k]; delete others[k];
      notify({ joined: [], updated: [], left: [peerOf(k, o.p)] });
    });
    ch.subscribe(status => {
      if (status === "SUBSCRIBED"){ joined = true; raw("hello", { f: me }); announce(); readyRes(); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") joined = false;
    });
    setInterval(() => {
      if (joined && Date.now() - lastSent > BEAT - 200) announce();
      const now = Date.now(), left = [];
      Object.keys(others).forEach(k => { if (now - others[k].t > EXPIRE){ left.push(peerOf(k, others[k].p)); delete others[k]; } });
      if (left.length) notify({ joined: [], updated: [], left });
    }, 1000);
    addEventListener("pagehide", () => { try { raw("bye", { f: me }); } catch(e){} });
    return {
      async emit(type, data){ await ready; const r = await raw("m", { t: type, d: data, f: me }); if (r !== "ok") throw new Error("emit " + r); },
      on(type, fn){ (handlers[type] = handlers[type] || []).push(fn); return () => { handlers[type] = (handlers[type] || []).filter(x => x !== fn); }; },
      async presence(obj){
        Object.keys(obj || {}).forEach(k => { if (obj[k] === null) delete mine[k]; else mine[k] = obj[k]; });
        schedule();
      },
      peers(){ return [peerOf(me, mine)].concat(Object.keys(others).map(k => peerOf(k, others[k].p))); },
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
    async pinLogin(pin){ const { data, error } = await sb.rpc("tn_pin_login", { p_pin: pin }); if (error) throw error; return data || null; },
    async setPin(u, pw, pin){ const { data, error } = await sb.rpc("tn_set_pin", { p_user: u, p_pw: pw, p_pin: pin }); if (error) throw error; return data; },
    /* organisation's own questions (TN-ORGQ): token from TN.login / TN.pinLogin */
    async orgqGet(tok){ const { data, error } = await sb.rpc("tn_orgq_get", { p_tok: tok }); if (error) throw error; return data; },
    async orgqSave(tok, items){ const { data, error } = await sb.rpc("tn_orgq_save", { p_tok: tok, p_items: items }); if (error) throw error; return data; },
    /* plan orders, contact messages and the owner's inbox (TN-ORDER) */
    async order(p){ const { data, error } = await sb.rpc("tn_order", { p }); if (error) throw error; return data; },
    async freeReg(p){ const { data, error } = await sb.rpc("tn_free_reg", { p }); if (error) throw error; return data; },
    async contact(p){ const { data, error } = await sb.rpc("tn_contact", { p }); if (error) throw error; return data; },
    async inbox(table){ const { data, error } = await sb.from(table).select("*").order("at", { ascending: false }).limit(300); if (error) throw error; return data || []; },
    async setStatus(table, id, status){ const { error } = await sb.from(table).update({ status }).eq("id", id); if (error) throw error; },
    /* counters and play log (TN-ID) */
    async visit(vid){ await sb.rpc("tn_visit", { p_vid: vid }); },
    async play(acct, contest){ await sb.rpc("tn_play", { p_acct: acct || "", p_contest: contest }); },
    async counts(){ const { data, error } = await sb.rpc("tn_counts"); if (error) throw error; return data; },
    async report(){ const { data, error } = await sb.rpc("tn_play_report"); if (error) throw error; return data || []; },
    async profile(u){ const { data, error } = await sb.rpc("tn_profile", { p_user: u }); if (error) return null; return data || null; },
    /* owner login (email + password, Supabase Auth) */
    async ownerLogin(email, pw){ const { error } = await sb.auth.signInWithPassword({ email, password: pw }); if (error) return false; return await isAdmin(); },
    async ownerLogout(){ await sb.auth.signOut(); }
  };
})();

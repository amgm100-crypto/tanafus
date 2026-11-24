#!/usr/bin/env python3
"""Build the hosted copy of تنافس from the artifact version.

  python3 build.py <supabase_url> <publishable_key> [out_dir]

Reads ../index.html, applies the hosting patches, inlines tn-backend.js and writes
<out_dir>/index.html (default ./dist). Every patch must match exactly once, so the
build fails loudly if index.html changed under it.
"""
import pathlib, sys, json

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent / "src" / "index.html"
SUPABASE_JS = "supabase-2.45.4.js"   # served next to index.html (copied from vendor/)

PATCHES = [
    # 1. capabilities come from the hosted backend (window.TN) instead of claude.ai
    ("useCap",
     "try { if (!window.claude || !window.claude.use) return null;\n    return await Promise.race([window.claude.use(name),",
     "try { const C = window.TN || window.claude; if (!C || !C.use) return null;\n    return await Promise.race([C.use(name),"),
    # 2. org profile for non-owners comes from a server function (hashes stay private)
    ("acGet",
     '  if (DB){ try { const d = await DB.doc("accounts/" + u).get();',
     '  if (DB && window.TN && !REAL_ADMIN) return TN.profile(u);\n  if (DB){ try { const d = await DB.doc("accounts/" + u).get();'),
    # 3. login: owner signs in with e-mail; orgs are checked on the server
    ("login",
     "      const a = await acGet(u);\n      if (!a || await acHash(a.salt, pw) !== a.hash){",
     "      if (window.TN && u.includes(\"@\")){ if (await TN.ownerLogin(u, pw)){ location.reload(); return; } err.textContent = \"بيانات المالك غير صحيحة.\"; return; }\n"
     "      const a = window.TN ? await TN.login(u, pw) : await acGet(u);\n      if (!a || (!window.TN && await acHash(a.salt, pw) !== a.hash)){"),
    # 4. owner sign-out button on the control card
    ("ownerOutBtn",
     '<div class="ac-btns"><button type="button" class="mini" id="acPvGuest">',
     '<div class="ac-btns">${window.TN ? `<button type="button" class="mini" id="acOwnerOut">خروج المالك</button>` : ""}<button type="button" class="mini" id="acPvGuest">'),
    ("ownerOutBind",
     '  const pg = document.getElementById("acPvGuest"); if (pg) pg.onclick = () => acPreview("guest");',
     '  const pg = document.getElementById("acPvGuest"); if (pg) pg.onclick = () => acPreview("guest");\n'
     '  const oo = document.getElementById("acOwnerOut"); if (oo) oo.onclick = () => TN.ownerLogout().then(() => location.reload());'),
]
# live-game invite banners: run when the hosted backend is present (2 places)
MULTI = [("inviteGuard",
          "if (!(window.claude && window.claude.use)) return;",
          "if (!(window.TN || (window.claude && window.claude.use))) return;", 2)]


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    url, key = sys.argv[1], sys.argv[2]
    out = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else HERE / "dist"
    html = SRC.read_text(encoding="utf-8")
    for name, old, new in PATCHES:
        c = html.count(old)
        if c != 1:
            sys.exit(f"patch {name}: expected 1 match, found {c}")
        html = html.replace(old, new)
    for name, old, new, n in MULTI:
        c = html.count(old)
        if c != n:
            sys.exit(f"patch {name}: expected {n} matches, found {c}")
        html = html.replace(old, new)
    backend = (HERE / "tn-backend.js").read_text(encoding="utf-8")
    head = (f'<script src="{SUPABASE_JS}"></script>\n'
            f'<script>window.TN_CONFIG = {json.dumps({"url": url, "key": key})};\n{backend}</script>\n')
    i = html.index("<script>")
    html = html[:i] + head + html[i:]
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / SUPABASE_JS).write_bytes((HERE / "vendor" / SUPABASE_JS).read_bytes())
    # short public link for players: <site>/join/ -> <site>/#join
    (out / "join").mkdir(exist_ok=True)
    (out / "join" / "index.html").write_text('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>تنافس · دخول اللاعبين</title><script>location.replace("../#join" + (location.hash ? "=" + location.hash.replace(/\\D/g, "") : ""))</script>'
        '<a href="../#join">دخول اللاعبين</a>', encoding="utf-8")
    for extra in ("_headers",):
        p = HERE / extra
        if p.exists():
            (out / extra).write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
    print("built", out / "index.html", f"{len(html)/1024:.0f} KB")


if __name__ == "__main__":
    main()

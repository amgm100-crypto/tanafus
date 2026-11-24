# تنافس

مسابقات ثقافية للجهات. الموقع المنشور في `docs/` (GitHub Pages).

- `src/index.html`: نسخة الموقع الأصلية (نفس نسخة claude.ai).
- `hosting/build.py`: يبني `docs/index.html` من `src/` ويربطه بـ Supabase:
  `python3 hosting/build.py https://pcawdjzmvsdiynimgbgu.supabase.co <publishable key> docs`
- `hosting/tn-backend.js`: قاعدة البيانات والغرفة المباشرة ودخول المالك على Supabase.
- `hosting/schema.sql`: جداول ودوال Supabase.
- `docs/questions.json`: بنك الأسئلة الاحتياطي إذا كانت قاعدة البيانات فاضية.

-- تنافس — تسجيل مقدّمي المسابقات المجانية (TN-FREEREG)
-- يُشغَّل مرة وحدة في Supabase: SQL Editor > New query > الصق الملف > Run
-- الزائر يرسل بياناته عبر tn_free_reg، والمدير فقط يقرأ الجدول ويغيّر الحالة.

create table if not exists public.free_regs (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  contest text not null,
  org     text not null,
  person  text not null,
  phone   text not null,
  email   text,
  logo    text,
  c1      text,
  c2      text,
  status  text not null default 'new'
);
alter table public.free_regs enable row level security;

drop policy if exists free_regs_admin_select on public.free_regs;
drop policy if exists free_regs_admin_update on public.free_regs;
drop policy if exists free_regs_admin_delete on public.free_regs;
create policy free_regs_admin_select on public.free_regs for select using ((select public.tn_is_admin()));
create policy free_regs_admin_update on public.free_regs for update using ((select public.tn_is_admin())) with check ((select public.tn_is_admin()));
create policy free_regs_admin_delete on public.free_regs for delete using ((select public.tn_is_admin()));

create or replace function public.tn_free_reg(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  ph text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  em text := trim(coalesce(p->>'email', ''));
  lg text := coalesce(p->>'logo', '');
  k  text := coalesce(p->>'contest', '');
begin
  if k !~ '^[a-z]{2}$' then return 'contest'; end if;
  if length(trim(coalesce(p->>'org', ''))) < 2 then return 'org'; end if;
  if length(trim(coalesce(p->>'person', ''))) < 2 then return 'person'; end if;
  if ph !~ '^[0-9]{8,15}$' then return 'phone'; end if;
  if em <> '' and em !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then return 'email'; end if;
  if lg !~ '^data:image/(png|jpeg|webp);base64,' or length(lg) > 400000 then return 'logo'; end if;
  insert into public.free_regs (contest, org, person, phone, email, logo, c1, c2)
  values (k, left(trim(p->>'org'), 80), left(trim(p->>'person'), 80), ph, nullif(left(em, 120), ''), lg,
          case when p->>'c1' ~ '^#[0-9a-fA-F]{6}$' then p->>'c1' end,
          case when p->>'c2' ~ '^#[0-9a-fA-F]{6}$' then p->>'c2' end);
  return 'ok';
end $$;

revoke all on function public.tn_free_reg(jsonb) from public;
grant execute on function public.tn_free_reg(jsonb) to anon, authenticated;

-- Applied to Supabase project tanafus (pcawdjzmvsdiynimgbgu, ap-south-1) on 2026-11-24 as migration tanafus_schema
-- تنافس — Supabase schema (run once on the new project)
create extension if not exists pgcrypto with schema extensions;

-- One generic document table: same shape as the claude.ai artifact db (collection + id + JSON)
create table if not exists public.docs (
  col     text not null,
  id      text not null,
  data    jsonb not null default '{}'::jsonb,
  updated timestamptz not null default now(),
  primary key (col, id)
);
alter table public.docs enable row level security;

create or replace function public.tn_is_admin() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
$$;

-- Everyone may read the question bank; nobody but the owner reads accounts.
drop policy if exists docs_read_public on public.docs;
create policy docs_read_public on public.docs for select
  using (col in ('chunks', 'meta') or public.tn_is_admin());
create policy docs_insert_admin on public.docs for insert with check ((select public.tn_is_admin()));
create policy docs_update_admin on public.docs for update using ((select public.tn_is_admin())) with check ((select public.tn_is_admin()));
create policy docs_delete_admin on public.docs for delete using ((select public.tn_is_admin()));

-- Org login: checks sha256(salt:password) server-side and returns only the public profile.
create or replace function public.tn_login(p_user text, p_pw text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d jsonb;
begin
  select data into d from public.docs where col = 'accounts' and id = lower(trim(p_user));
  if d is null or d->>'salt' is null then return null; end if;
  if encode(extensions.digest((d->>'salt') || ':' || p_pw, 'sha256'), 'hex') <> d->>'hash' then return null; end if;
  return jsonb_build_object('user', lower(trim(p_user)), 'org', d->'org', 'logo', d->'logo',
                            'c1', d->'c1', 'c2', d->'c2', 'active', coalesce((d->>'active')::boolean, true));
end $$;

-- Brand refresh for a logged-in org (no hash, no salt).
create or replace function public.tn_profile(p_user text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('user', id, 'org', data->'org', 'logo', data->'logo', 'c1', data->'c1', 'c2', data->'c2',
                            'active', coalesce((data->>'active')::boolean, true))
  from public.docs where col = 'accounts' and id = lower(trim(p_user))
$$;

revoke all on function public.tn_login(text, text) from public;
revoke all on function public.tn_profile(text) from public;
grant execute on function public.tn_login(text, text) to anon, authenticated;
grant execute on function public.tn_profile(text) to anon, authenticated;

-- Make the owner an admin (after creating the owner user in Authentication > Users):
-- update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}' where email = '<owner email>';

-- 2026-11-24 migration tanafus_host_pin: presenter PIN per organisation
-- tn_login also returns the org's own pin; tn_pin_login signs a presenter in with the 6-digit PIN;
-- tn_set_pin lets the org change its PIN after confirming its password.
-- (functions tn_pin_login(p_pin), tn_set_pin(p_user,p_pw,p_pin) and the updated tn_login are in the
--  migration of the same name in Supabase; see list_migrations for the exact SQL)

-- 2026-11-25 migration tanafus_stats: tables plays(acct, contest, at) and visitors(vid); RPCs tn_play, tn_visit,
-- tn_counts (public numbers for the home page) and tn_play_report (owner only: plays per account per contest).

-- 2026-11-25 migration tanafus_org_questions: org_tokens (60-day session tokens from tn_login / tn_pin_login),
-- org_questions(acct, items); RPCs tn_orgq_get (org or presenter token) and tn_orgq_save (org token only).

-- 2026-11-25 migration tanafus_org_games: tn_login, tn_pin_login and tn_profile also return the account's `games` (null = all contests).
-- tanafus_orders_contact (2026-11-25): orders + messages tables (admin RLS), tn_order(p jsonb) / tn_contact(p jsonb) RPCs for anon, returning ok or an error code.

-- tanafus_free_regs (2026-11-25): sign-ups for contests that are free for a limited time (TN-FREEREG).
-- A visitor registers their organisation (name, contact, logo, colours) once per contest before playing it.
-- free_regs is admin-only (RLS); anon inserts only through tn_free_reg, which validates and rate-limits
-- (3 per phone per day, 30 per hour site-wide) and returns 'ok' or an error code.
create table if not exists public.free_regs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  contest text not null, org text not null, person text not null,
  phone text not null, email text, logo text, c1 text, c2 text,
  status text not null default 'new'
);
create index if not exists free_regs_phone_at on public.free_regs (phone, at);
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
  if (select count(*) from public.free_regs where phone = ph and at > now() - interval '1 day') >= 3 then return 'limit'; end if;
  if (select count(*) from public.free_regs where at > now() - interval '1 hour') >= 30 then return 'busy'; end if;
  insert into public.free_regs (contest, org, person, phone, email, logo, c1, c2)
  values (k, left(trim(p->>'org'), 80), left(trim(p->>'person'), 80), ph, nullif(left(em, 120), ''), lg,
    case when p->>'c1' ~ '^#[0-9a-fA-F]{6}$' then p->>'c1' end,
    case when p->>'c2' ~ '^#[0-9a-fA-F]{6}$' then p->>'c2' end);
  return 'ok';
end $$;
revoke all on function public.tn_free_reg(jsonb) from public;
grant execute on function public.tn_free_reg(jsonb) to anon, authenticated;

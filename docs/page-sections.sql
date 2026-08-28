-- Editable page copy, and who may write it.
--
-- The pencil in the help page is presentation: it is hidden for everyone whose
-- email is not in SITE.editors, and hiding a button stops an accident rather
-- than an attacker. This policy is the part that actually decides, because it
-- checks the signed-in user server-side where nobody can edit it in devtools.
--
-- Run once, in the Supabase SQL editor.

create table if not exists public.page_sections (
  page       text        not null,
  slug       text        not null,
  html       text        not null,
  updated_at timestamptz not null default now(),
  updated_by text        not null default '',
  primary key (page, slug)
);

alter table public.page_sections enable row level security;

-- Anyone may read: this is the site's own copy, and the help page has to work
-- signed out.
drop policy if exists "page sections are public" on public.page_sections;
create policy "page sections are public"
  on public.page_sections for select
  using (true);

-- Exactly one account may write. auth.jwt() ->> 'email' is the signed-in
-- user's own email as the server sees it; a client cannot forge it, which is
-- the whole reason the rule lives here and not in the browser.
drop policy if exists "only the owner may write page sections" on public.page_sections;
create policy "only the owner may write page sections"
  on public.page_sections for all
  using (auth.jwt() ->> 'email' = 'shermancahal@gmail.com')
  with check (auth.jwt() ->> 'email' = 'shermancahal@gmail.com');

-- Client portal schema, initial migration.
--
-- Design notes:
--  * Identity comes from Google OAuth. There is no password column anywhere, and
--    signing in with Google grants nothing on its own: the sign in callback looks
--    the email up in "users" and rejects anything an owner has not invited.
--  * Sessions stay stateless JWT cookies, so there are no Auth.js adapter tables
--    (no account or session table). This keeps the schema small; the cost is that
--    deactivating a user takes effect on their next request check, not instantly.
--  * Email uniqueness is a unique index on lower(email) rather than citext, so the
--    same SQL runs on Supabase, plain Postgres and PGlite.
--
-- See docs/client-portal-plan.md sections 5 and 12b.

create table if not exists clients (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Owners are Sudaan staff (Malhar, Prakhar) and have no client.
-- Client users belong to exactly one client.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  full_name     text,
  image_url     text,
  role          text not null default 'client' check (role in ('owner', 'client')),
  client_id     uuid references clients(id) on delete cascade,
  invited_by    uuid references users(id) on delete set null,
  is_active     boolean not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  constraint owners_have_no_client check (
    (role = 'owner' and client_id is null) or (role = 'client' and client_id is not null)
  )
);

create unique index if not exists users_email_lower_idx on users (lower(email));
create index if not exists users_client_idx on users (client_id);

-- A surveyed project. Nothing is visible to a client until is_published is true,
-- so owners can stage a site while it is still being assembled.
create table if not exists sites (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  slug          text not null,
  name          text not null,
  location      text,
  district      text,
  state         text,
  area_label    text,
  industry      text,
  status        text not null default 'delivered'
                check (status in ('in_progress', 'delivered', 'archived')),
  summary       text,
  thumbnail_key text,
  is_published  boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (client_id, slug)
);

create index if not exists sites_client_idx on sites (client_id);

create table if not exists surveys (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references sites(id) on delete cascade,
  label      text not null,
  flown_on   date not null,
  notes      text,
  created_at timestamptz not null default now()
);

create index if not exists surveys_site_idx on surveys (site_id);

create table if not exists assets (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references sites(id) on delete cascade,
  survey_id    uuid references surveys(id) on delete set null,
  category     text not null check (category in (
                 'report', 'drawing', 'photo', 'uav_dgps',
                 'lidar', 'control_area', 'misc')),
  title        text not null,
  file_name    text not null,
  storage_key  text not null,
  mime_type    text not null,
  description  text,
  size_bytes   bigint,
  is_published boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists assets_site_category_idx on assets (site_id, category);

create table if not exists videos (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references sites(id) on delete cascade,
  title      text not null,
  youtube_id text not null,
  kind       text not null default 'other'
             check (kind in ('front_view', '360_view', 'walkthrough', 'other')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists videos_site_idx on videos (site_id);

-- Optional narrowing. No rows for a user means "every published site of my client",
-- which is the common case and keeps the owner console simple.
create table if not exists user_site_grants (
  user_id    uuid not null references users(id) on delete cascade,
  site_id    uuid not null references sites(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, site_id)
);

-- Who looked at what.
create table if not exists access_log (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete set null,
  client_id  uuid references clients(id) on delete set null,
  event      text not null,
  target     text,
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists access_log_created_idx on access_log (created_at desc);

-- Who changed access, so "who gave them that" is always answerable.
create table if not exists access_changes (
  id         bigserial primary key,
  actor_id   uuid references users(id) on delete set null,
  action     text not null,
  subject    text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index if not exists access_changes_created_idx on access_changes (created_at desc);

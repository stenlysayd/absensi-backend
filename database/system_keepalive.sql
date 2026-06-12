create table if not exists public.system_keepalive (
  value smallint primary key,
  constraint system_keepalive_value_check check (value in (0, 1))
);

comment on table public.system_keepalive is
  'Single-row heartbeat toggled by the backend daily maintenance cron.';

create unique index if not exists system_keepalive_single_row_idx
on public.system_keepalive ((true));

alter table public.system_keepalive enable row level security;
revoke all on table public.system_keepalive from anon, authenticated;

insert into public.system_keepalive (value)
values (0)
on conflict (value) do nothing;

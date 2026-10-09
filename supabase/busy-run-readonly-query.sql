-- JCM-Busysql project (NOT the main CRM project) — run once in
-- Project → SQL Editor → New query.
--
-- Backs the "Ask AI" chat on the Items Management page: lets a trusted
-- server-side caller (the service_role key, held only in the db-chat
-- Vercel function's env vars, never the browser) run an arbitrary but
-- read-only SELECT built by Claude from a natural-language question.
-- Never grants write access, no matter what the query text says --
-- enforced here even if the app-layer check in api/db-chat.js is ever
-- bypassed or changed.

create or replace function run_readonly_query(query text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result json;
begin
  if query !~* '^\s*select' then
    raise exception 'Only SELECT statements are allowed';
  end if;
  if query ~* '\y(insert|update|delete|drop|alter|truncate|grant|revoke|create)\y' then
    raise exception 'Query contains a disallowed keyword';
  end if;
  execute format('select json_agg(t) from (%s limit 200) t', query) into result;
  return result;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default -- revoke
-- that explicitly before granting only to service_role, or the "not anon"
-- requirement silently doesn't hold.
revoke all on function run_readonly_query(text) from public;
grant execute on function run_readonly_query(text) to service_role;

notify pgrst, 'reload schema';

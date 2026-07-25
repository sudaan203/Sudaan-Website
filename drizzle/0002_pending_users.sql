-- Anyone may sign in with Google; access is what the owners grant afterwards.
--
-- The original rule forced every client user to belong to a client, which meant
-- an uninvited person could not be recorded at all and had to be refused at the
-- door. The owners want the opposite: let people in, show them nothing, and let
-- an owner attach them to a client from the console. So a client row may now sit
-- "pending" with no client_id.
--
-- Owners still may not belong to a client, which is the half of the rule worth
-- keeping.

alter table users drop constraint if exists owners_have_no_client;

alter table users
  add constraint owners_have_no_client
  check (role <> 'owner' or client_id is null);

-- Pending people are looked up constantly by the console, so index the state.
create index if not exists users_pending_idx on users (client_id) where client_id is null;

-- Same-organization link between events and clients.
--
-- The API already scopes the link per org (event.create/duplicate in
-- server/state.js, event.update in server/commands/preparation.js), but two
-- roots joined only in application code deserve a database backstop: a client
-- of org B must never become the client_id of an org A event, in either
-- direction, regardless of which code path writes it.
--
-- A trigger (not a plain FK) because the rule spans two nullable columns:
-- rows with no client, or pre-tenancy rows the backfill could not classify,
-- keep passing; only an explicit cross-org link raises.

CREATE OR REPLACE FUNCTION enforce_event_client_same_org()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_org text;
  client_org text;
BEGIN
  IF NEW.client_id IS NULL THEN
    RETURN NEW;
  END IF;
  event_org := NEW.org_id;
  IF event_org IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT org_id INTO client_org FROM clients WHERE id = NEW.client_id;
  IF client_org IS NULL THEN
    RETURN NEW;
  END IF;
  IF event_org <> client_org THEN
    RAISE EXCEPTION 'event % and client % belong to different organizations', NEW.id, NEW.client_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_client_same_org ON events;

CREATE TRIGGER events_client_same_org
  BEFORE INSERT OR UPDATE OF org_id, client_id ON events
  FOR EACH ROW EXECUTE FUNCTION enforce_event_client_same_org();

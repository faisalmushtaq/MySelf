-- The home address (survey r8.0.0 on, D-52), which replaced the secret code.
--
-- Additive and nullable: no existing row is rewritten, and a database that has
-- never received an r8.0.0 sitting behaves exactly as before.
--
-- Kept as the participant gave it, {postcode, house, street}, any part absent.
-- The claim keeps the address given at each sitting. The registry keeps the one
-- from the most recent sitting, with that sitting's time: unlike a name, an
-- address is expected to change, and a sitting uploaded late must not overwrite
-- a newer address with an older one.
--
-- Access follows the tables': the linkage role can read and write them, the
-- research role has no grant on the identity schema at all (002, 004).
ALTER TABLE identity.code_claims
  ADD COLUMN IF NOT EXISTS home_address jsonb;

ALTER TABLE identity.participants
  ADD COLUMN IF NOT EXISTS home_address jsonb,
  ADD COLUMN IF NOT EXISTS home_address_recorded_at timestamptz;

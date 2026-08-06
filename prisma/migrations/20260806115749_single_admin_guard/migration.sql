-- Spec §1.1: exactly one Main Admin. This partial unique index makes it
-- impossible at the DB level for a second ADMIN row to ever exist.
-- ("Exactly one" — i.e. non-zero — is guaranteed by the seed plus the
-- application refusing to demote/deactivate/delete the admin.)
CREATE UNIQUE INDEX "one_main_admin" ON "User" ((role)) WHERE role = 'ADMIN';

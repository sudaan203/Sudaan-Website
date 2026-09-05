-- Vertical accuracy belongs to a survey, not to the company.
--
-- Until now every elevation the portal put in front of a client carried "±4 cm",
-- and it came from one environment variable with a hardcoded 0.04 default,
-- applied to every site ever published. The wording beside it said "the survey's
-- own checkpoint report". It was not: 3 to 4 cm is Sudaan's advertised figure.
-- Kotba, Aektanagar and Kiru were flown on different days, with different
-- equipment, over very different ground, and they cannot all be accurate to the
-- same centimetre. That claim sits under every volume, cut and fill, spot level
-- and cross section the portal has shown anyone, so it is a commercial exposure
-- rather than a cosmetic one.
--
-- Nullable, and left null on every existing row. Null means "no checkpoint
-- report has been supplied for this survey", which is the true state of all
-- three today, and the application treats it as a first class case rather than
-- substituting a default.
--
-- THIS MIGRATION DELIBERATELY BACKFILLS NOTHING. Writing 0.040 into these rows
-- would launder the advertised figure into the database, where it would be
-- indistinguishable from a measurement a week later. That is precisely the bug
-- being fixed, and it would be harder to find the second time.
--
-- ## Why a bare number is not enough
--
-- A number with no provenance is half of what created this problem, so the
-- provenance travels with it and the constraints below refuse a figure that
-- arrives without any:
--
--   basis         RMSE(z) and a 95% confidence interval are different claims
--                 about the same survey and differ by a factor of about 1.96.
--                 Storing "0.04" without saying which is how a 4 cm RMSE gets
--                 quoted to a contractor as a 4 cm worst case.
--   checkpoints   an RMSE over 5 checkpoints and one over 60 are not the same
--                 evidence. "How do you know" is usually asking this.
--   assessed_on   NOT the flight date; surveys.flown_on already holds that. A
--                 model reprocessed a year later has a new accuracy figure
--                 against the same flight, and dating it to the flight would
--                 attach the new number to the old work.
--   method        how the check was made, in the surveyor's words, e.g.
--                 "27 DGPS checkpoints, independent of the control network".
--   source        the document the figure can be read out of, so "where does
--                 this come from" is answered with a filename and not a person.
--
-- Kept on sites rather than on surveys because the portal measures against one
-- published DTM per site, which is what loadTerrain/openTerrain resolve, and an
-- accuracy attached to a flight the portal never reads from could not be shown
-- honestly beside a number the portal does read. When a site starts carrying
-- more than one measurable epoch this moves to surveys, and the constraint set
-- moves with it unchanged.

alter table sites
  add column if not exists vertical_rmse_z_m             numeric(6, 3),
  add column if not exists vertical_accuracy_basis       text,
  add column if not exists vertical_accuracy_checkpoints integer,
  add column if not exists vertical_accuracy_assessed_on date,
  add column if not exists vertical_accuracy_method      text,
  add column if not exists vertical_accuracy_source      text;

-- Constraints are dropped before being added so this file is re-runnable by
-- hand. The ledger in portal_schema_migrations already applies it once, but a
-- migration that cannot be replayed onto a restored database is a migration
-- somebody edits under pressure.

alter table sites drop constraint if exists sites_vertical_accuracy_positive;
alter table sites
  add constraint sites_vertical_accuracy_positive
  check (vertical_rmse_z_m is null or vertical_rmse_z_m > 0);

alter table sites drop constraint if exists sites_vertical_accuracy_basis_known;
alter table sites
  add constraint sites_vertical_accuracy_basis_known
  check (vertical_accuracy_basis is null or vertical_accuracy_basis in ('rmse', 'ci95'));

alter table sites drop constraint if exists sites_vertical_accuracy_checkpoints_positive;
alter table sites
  add constraint sites_vertical_accuracy_checkpoints_positive
  check (vertical_accuracy_checkpoints is null or vertical_accuracy_checkpoints > 0);

-- The rule that stops this column becoming the old environment variable with
-- extra steps: a figure may only be recorded together with what it is, what it
-- was measured against and when.
alter table sites drop constraint if exists sites_vertical_accuracy_has_provenance;
alter table sites
  add constraint sites_vertical_accuracy_has_provenance
  check (
    vertical_rmse_z_m is null
    or (
      vertical_accuracy_basis is not null
      and vertical_accuracy_checkpoints is not null
      and vertical_accuracy_assessed_on is not null
    )
  );

-- And the mirror of it, so a half-filled row is caught on the way in rather than
-- read later as evidence of a check that was never recorded.
alter table sites drop constraint if exists sites_vertical_accuracy_needs_figure;
alter table sites
  add constraint sites_vertical_accuracy_needs_figure
  check (
    vertical_rmse_z_m is not null
    or (
      vertical_accuracy_basis is null
      and vertical_accuracy_checkpoints is null
      and vertical_accuracy_assessed_on is null
      and vertical_accuracy_method is null
      and vertical_accuracy_source is null
    )
  );

comment on column sites.vertical_rmse_z_m is
  'Vertical accuracy in metres, from this survey''s own checkpoint report. Null means no report has been supplied: the portal then says so rather than quoting the company figure as a measurement.';
comment on column sites.vertical_accuracy_basis is
  'What the number is: rmse = RMSE(z), ci95 = 95% confidence interval. They differ by about 1.96x and must never be shown interchangeably.';
comment on column sites.vertical_accuracy_assessed_on is
  'When the accuracy was assessed, which is not the flight date. See surveys.flown_on for that.';

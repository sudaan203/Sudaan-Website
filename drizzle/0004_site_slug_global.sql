-- A site's slug identifies it everywhere outside this database, so it has to be
-- unique everywhere, not merely within one client.
--
-- The constraint until now was `unique (client_id, slug)`, which permits two
-- different clients to each own a site called `kotba-survey`. That reads as
-- reasonable tenancy — until you follow where the slug goes:
--
--   * R2 objects live at `sites/<slug>/dtm.tif`, `sites/<slug>/hydrology/...`
--   * `openTerrain(siteSlug)` resolves a raster by slug alone
--   * the tile Worker's grant is minted for a slug and `keyIsWithinSite`
--     authorises the prefix `sites/<slug>/`
--
-- None of those carry a client. Two clients sharing a slug would therefore
-- share one set of rasters, and a grant issued to one would authorise the
-- other's prefix, because it is the same prefix. The row-level tenancy checks
-- would all still pass: the leak is downstream of them, in a namespace that
-- never had a tenant in it.
--
-- Nothing observed has ever collided. Verified before applying: zero slugs
-- appear more than once across all clients. This makes the guarantee the rest
-- of the system already assumes into one the database enforces.

alter table sites drop constraint if exists sites_client_id_slug_key;

alter table sites add constraint sites_slug_key unique (slug);

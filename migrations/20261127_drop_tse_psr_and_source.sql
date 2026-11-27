-- =============================================================================
-- 20261127_drop_tse_psr_and_source.sql
-- WHAT   TPJP covers only the agreed roles (Super Admin, Admin, GM, ZM, RM, ASM).
--        TSE and PSR are not used: drop tsemaster, psrmaster and the dealer links to them.
--        Every import (customer master, T-1 sales) arrives through SFTP only, so
--        importbatchmaster.source is always the same value: drop it. triggeredby tells a
--        scheduled run (NULL) from a manual run (user id).
-- SAFE   Every statement uses IF EXISTS, so the file can run on a database where some
--        objects are already gone. No CASCADE: anything else depending on these objects
--        makes the migration fail instead of being dropped silently.
-- =============================================================================

-- 1. Dealer links to TSE and PSR (children first)
ALTER TABLE dealermaster DROP CONSTRAINT IF EXISTS fk_dealermaster_psr;
ALTER TABLE dealermaster DROP CONSTRAINT IF EXISTS fk_dealermaster_tse;
DROP INDEX IF EXISTS idx_dealermaster_psrid;
DROP INDEX IF EXISTS idx_dealermaster_tseid;
ALTER TABLE dealermaster DROP COLUMN IF EXISTS psrid;
ALTER TABLE dealermaster DROP COLUMN IF EXISTS tseid;

-- 2. PSR before TSE (psrmaster references tsemaster). Their indexes go with the tables.
DROP TABLE IF EXISTS psrmaster;
DROP TABLE IF EXISTS tsemaster;

-- 3. Import source
ALTER TABLE importbatchmaster DROP CONSTRAINT IF EXISTS chk_importbatchmaster_source;
ALTER TABLE importbatchmaster DROP COLUMN IF EXISTS source;

-- -----------------------------------------------------------------------------
-- ROLLBACK (commented). Data comes back only from the backups taken before this ran
-- (Task/task-05-Migration-Runner-Drop-TSE-PSR/backup/).
-- -----------------------------------------------------------------------------
-- 1. Re-run the tsemaster and psrmaster CREATE TABLE blocks and their indexes from
--    20261126_create_customer_masters.sql; reload them from tsemaster.csv / psrmaster.csv.
-- 2. ALTER TABLE dealermaster ADD COLUMN IF NOT EXISTS tseid integer;
--    ALTER TABLE dealermaster ADD COLUMN IF NOT EXISTS psrid integer;
--    reload both from dealermaster_tse_psr.csv, then re-add fk_dealermaster_tse,
--    fk_dealermaster_psr, idx_dealermaster_tseid, idx_dealermaster_psrid.
-- 3. ALTER TABLE importbatchmaster ADD COLUMN IF NOT EXISTS source varchar(20);
--    fill it, SET NOT NULL, re-add CHECK (source IN ('sftp', 'manual')).

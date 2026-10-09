-- Authentication tables: dashboard users and their sign-in sessions.
-- House conventions: lowercase names without underscores, smallint 0/1 flags,
-- soft delete, audit columns, named constraints (registered in src/utils/pgError.ts).
-- rolecode is checked by the application against src/config/permissions.ts, so a
-- project can change its roles without a migration.

CREATE TABLE IF NOT EXISTS usermaster (
    id            serial       PRIMARY KEY,
    username      varchar(64)  NOT NULL,
    fullname      varchar(150) NOT NULL,
    rolecode      varchar(30)  NOT NULL,
    passwordhash  varchar(100) NOT NULL,
    failedlogins  smallint     NOT NULL DEFAULT 0,
    lockeduntil   timestamptz,
    lastloginat   timestamptz,
    isactive      smallint     NOT NULL DEFAULT 1,
    isdeleted     smallint     NOT NULL DEFAULT 0,
    createdby     int          NOT NULL DEFAULT 0,
    createdat     timestamptz  NOT NULL DEFAULT NOW(),
    updatedby     int          NOT NULL DEFAULT 0,
    updatedat     timestamptz  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_usermaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT ck_usermaster_isdeleted CHECK (isdeleted IN (0, 1))
);

-- Usernames are stored lower-cased by the application. Partial: a deleted user
-- must not reserve the name forever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_usermaster_username
    ON usermaster (username) WHERE isdeleted = 0;

-- One row per signed-in device. The refresh token itself is never stored, only
-- its SHA-256 hash; `generation` increases on every refresh so a replayed older
-- token is detected and every session of that user is revoked.
CREATE TABLE IF NOT EXISTS authsession (
    id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    usermaster_id     int          NOT NULL,
    refreshtokenhash  varchar(64)  NOT NULL,
    generation        int          NOT NULL DEFAULT 1,
    useragent         varchar(255),
    ipaddress         varchar(45),
    expiresat         timestamptz  NOT NULL,
    revokedat         timestamptz,
    isdeleted         smallint     NOT NULL DEFAULT 0,
    createdby         int          NOT NULL DEFAULT 0,
    createdat         timestamptz  NOT NULL DEFAULT NOW(),
    updatedby         int          NOT NULL DEFAULT 0,
    updatedat         timestamptz  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_authsession_usermaster FOREIGN KEY (usermaster_id) REFERENCES usermaster (id)
);

CREATE INDEX IF NOT EXISTS ix_authsession_usermaster
    ON authsession (usermaster_id) WHERE revokedat IS NULL AND isdeleted = 0;

-- =============================================================================
-- 20261126_create_customer_masters.sql                 (PostgreSQL 16)
--
-- WHAT   Customer master tables: lookups, sales hierarchy (GM, ZM, RM, ASM, TSE, PSR),
--        distributors, dealers, distributor assignment history, import batches and
--        import errors. Plus usermaster and authsession for Super Admin login
--        (added 2026-11-27, task-04).
-- WHY    Hold the .NET team's DMS customer master ("dist-dealer reference format")
--        in TPJP. Project database changed from MongoDB to PostgreSQL on 2026-11-26.
-- ASKED  Developer, 2026-11-26
--
-- Re-runnable: every statement uses IF NOT EXISTS. Apply by hand (DBeaver); there is no runner.
-- Never edit this file after it has run anywhere except your own machine.
-- No triggers, no cascades: the app writes updatedat/updatedby and soft-deletes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABLES  (parents before children)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS importbatchmaster (
    importbatchid              bigserial      PRIMARY KEY,
    batchtype                  varchar(30)    NOT NULL,
    source                     varchar(20)    NOT NULL,
    filename                   varchar(255)   NOT NULL,
    filepath                   varchar(500),
    filehash                   varchar(64),
    triggeredby                integer,
    status                     varchar(30)    DEFAULT 'received' NOT NULL,
    totalrows                  integer        DEFAULT 0 NOT NULL,
    insertedrows               integer        DEFAULT 0 NOT NULL,
    updatedrows                integer        DEFAULT 0 NOT NULL,
    deactivatedrows            integer        DEFAULT 0 NOT NULL,
    rejectedrows               integer        DEFAULT 0 NOT NULL,
    startedat                  timestamp,
    finishedat                 timestamp,
    errormessage               varchar(500),
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_importbatchmaster_batchtype CHECK (batchtype IN ('customer_master', 't1_sales')),
    CONSTRAINT chk_importbatchmaster_source CHECK (source IN ('sftp', 'manual')),
    CONSTRAINT chk_importbatchmaster_status CHECK (status IN ('received', 'processing', 'completed', 'completed_with_errors', 'failed')),
    CONSTRAINT chk_importbatchmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT chk_importbatchmaster_totalrows CHECK (totalrows >= 0),
    CONSTRAINT chk_importbatchmaster_insertedrows CHECK (insertedrows >= 0),
    CONSTRAINT chk_importbatchmaster_updatedrows CHECK (updatedrows >= 0),
    CONSTRAINT chk_importbatchmaster_deactivatedrows CHECK (deactivatedrows >= 0),
    CONSTRAINT chk_importbatchmaster_rejectedrows CHECK (rejectedrows >= 0)
);

CREATE TABLE IF NOT EXISTS zonemaster (
    zoneid                     serial         PRIMARY KEY,
    zonecode                   varchar(20)    NOT NULL,
    zonename                   varchar(100)   NOT NULL,
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_zonemaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_zonemaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_zonemaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS regionmaster (
    regionid                   serial         PRIMARY KEY,
    zoneid                     integer        NOT NULL,
    regioncode                 varchar(20)    NOT NULL,
    regionname                 varchar(100)   NOT NULL,
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_regionmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_regionmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_regionmaster_zone FOREIGN KEY (zoneid) REFERENCES zonemaster (zoneid),
    CONSTRAINT fk_regionmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS areamaster (
    areaid                     serial         PRIMARY KEY,
    regionid                   integer,
    areacode                   varchar(20)    NOT NULL,
    areaname                   varchar(100)   NOT NULL,
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_areamaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_areamaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_areamaster_region FOREIGN KEY (regionid) REFERENCES regionmaster (regionid),
    CONSTRAINT fk_areamaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS statemaster (
    stateid                    serial         PRIMARY KEY,
    statecode                  varchar(20)    NOT NULL,
    statename                  varchar(100)   NOT NULL,
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_statemaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_statemaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_statemaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS channelmaster (
    channelid                  serial         PRIMARY KEY,
    channelcode                varchar(20)    NOT NULL,
    channelname                varchar(100)   NOT NULL,
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_channelmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_channelmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_channelmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS customerclassificationmaster (
    customerclassificationid   serial         PRIMARY KEY,
    customerclassificationcode varchar(20)    NOT NULL,
    customerclassificationname varchar(100)   NOT NULL,
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_customerclassificationmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_customerclassificationmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_customerclassificationmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS gmmaster (
    gmid                       serial         PRIMARY KEY,
    employeecode               varchar(20)    NOT NULL,
    gmname                     varchar(150)   NOT NULL,
    mobileno                   varchar(20),
    email                      varchar(150),
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_gmmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_gmmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_gmmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS zmmaster (
    zmid                       serial         PRIMARY KEY,
    gmid                       integer,
    employeecode               varchar(20)    NOT NULL,
    zmname                     varchar(150)   NOT NULL,
    mobileno                   varchar(20),
    email                      varchar(150),
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_zmmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_zmmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_zmmaster_gm FOREIGN KEY (gmid) REFERENCES gmmaster (gmid),
    CONSTRAINT fk_zmmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS rmmaster (
    rmid                       serial         PRIMARY KEY,
    zmid                       integer,
    gmid                       integer,
    employeecode               varchar(20)    NOT NULL,
    rmname                     varchar(150)   NOT NULL,
    mobileno                   varchar(20),
    email                      varchar(150),
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_rmmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_rmmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_rmmaster_zm FOREIGN KEY (zmid) REFERENCES zmmaster (zmid),
    CONSTRAINT fk_rmmaster_gm FOREIGN KEY (gmid) REFERENCES gmmaster (gmid),
    CONSTRAINT fk_rmmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS asmmaster (
    asmid                      serial         PRIMARY KEY,
    rmid                       integer,
    zmid                       integer,
    gmid                       integer,
    employeecode               varchar(20)    NOT NULL,
    asmname                    varchar(150)   NOT NULL,
    mobileno                   varchar(20),
    email                      varchar(150),
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_asmmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_asmmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_asmmaster_rm FOREIGN KEY (rmid) REFERENCES rmmaster (rmid),
    CONSTRAINT fk_asmmaster_zm FOREIGN KEY (zmid) REFERENCES zmmaster (zmid),
    CONSTRAINT fk_asmmaster_gm FOREIGN KEY (gmid) REFERENCES gmmaster (gmid),
    CONSTRAINT fk_asmmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS tsemaster (
    tseid                      serial         PRIMARY KEY,
    asmid                      integer,
    rmid                       integer,
    zmid                       integer,
    gmid                       integer,
    employeecode               varchar(20)    NOT NULL,
    tsename                    varchar(150)   NOT NULL,
    mobileno                   varchar(20),
    email                      varchar(150),
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_tsemaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_tsemaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_tsemaster_asm FOREIGN KEY (asmid) REFERENCES asmmaster (asmid),
    CONSTRAINT fk_tsemaster_rm FOREIGN KEY (rmid) REFERENCES rmmaster (rmid),
    CONSTRAINT fk_tsemaster_zm FOREIGN KEY (zmid) REFERENCES zmmaster (zmid),
    CONSTRAINT fk_tsemaster_gm FOREIGN KEY (gmid) REFERENCES gmmaster (gmid),
    CONSTRAINT fk_tsemaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS psrmaster (
    psrid                      serial         PRIMARY KEY,
    tseid                      integer,
    asmid                      integer,
    rmid                       integer,
    zmid                       integer,
    gmid                       integer,
    employeecode               varchar(20)    NOT NULL,
    psrname                    varchar(150)   NOT NULL,
    mobileno                   varchar(20),
    email                      varchar(150),
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_psrmaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_psrmaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_psrmaster_tse FOREIGN KEY (tseid) REFERENCES tsemaster (tseid),
    CONSTRAINT fk_psrmaster_asm FOREIGN KEY (asmid) REFERENCES asmmaster (asmid),
    CONSTRAINT fk_psrmaster_rm FOREIGN KEY (rmid) REFERENCES rmmaster (rmid),
    CONSTRAINT fk_psrmaster_zm FOREIGN KEY (zmid) REFERENCES zmmaster (zmid),
    CONSTRAINT fk_psrmaster_gm FOREIGN KEY (gmid) REFERENCES gmmaster (gmid),
    CONSTRAINT fk_psrmaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS distributormaster (
    distributorid              serial         PRIMARY KEY,
    distributorcode            varchar(20)    NOT NULL,
    distributorname            varchar(150)   NOT NULL,
    parentdistributorid        integer,
    gmid                       integer,
    zmid                       integer,
    rmid                       integer,
    asmid                      integer,
    zoneid                     integer        NOT NULL,
    regionid                   integer        NOT NULL,
    areaid                     integer,
    stateid                    integer        NOT NULL,
    channelid                  integer        NOT NULL,
    customerclassificationid   integer        NOT NULL,
    salesdistrictcode          varchar(20)    NOT NULL,
    salesdistrictname          varchar(100),
    ownerfirstname             varchar(100),
    ownerlastname              varchar(100),
    mobileno                   varchar(20),
    phoneno                    varchar(20),
    email                      varchar(150),
    address                    varchar(200),
    cityname                   varchar(100),
    pincode                    varchar(20),
    grade                      varchar(20),
    pricegroupcode             varchar(20),
    pricegroupname             varchar(100),
    paymenttermscode           varchar(20),
    paymenttermsname           varchar(100),
    customergroupcode          varchar(20),
    customergroupname          varchar(100),
    deliveryplantcode          varchar(20),
    deliveryplantname          varchar(100),
    expectedsale               numeric(14,2),
    salesempcode               varchar(20),
    salesempname               varchar(150),
    startdate                  date,
    enddate                    date,
    remark                     varchar(255),
    dmsstatus                  varchar(20),
    dmsmodifiedat              timestamp,
    gstno                      varchar(20),
    panno                      varchar(20),
    creditlimit                numeric(14,2),
    routecode                  varchar(20),
    routename                  varchar(100),
    distancekm                 integer,
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_distributormaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_distributormaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT chk_distributormaster_expectedsale CHECK (expectedsale IS NULL OR expectedsale >= 0),
    CONSTRAINT chk_distributormaster_creditlimit CHECK (creditlimit IS NULL OR creditlimit >= 0),
    CONSTRAINT chk_distributormaster_distancekm CHECK (distancekm IS NULL OR distancekm >= 0),
    CONSTRAINT chk_distributormaster_dates CHECK (enddate IS NULL OR startdate IS NULL OR enddate >= startdate),
    CONSTRAINT fk_distributormaster_parentdistributor FOREIGN KEY (parentdistributorid) REFERENCES distributormaster (distributorid),
    CONSTRAINT fk_distributormaster_gm FOREIGN KEY (gmid) REFERENCES gmmaster (gmid),
    CONSTRAINT fk_distributormaster_zm FOREIGN KEY (zmid) REFERENCES zmmaster (zmid),
    CONSTRAINT fk_distributormaster_rm FOREIGN KEY (rmid) REFERENCES rmmaster (rmid),
    CONSTRAINT fk_distributormaster_asm FOREIGN KEY (asmid) REFERENCES asmmaster (asmid),
    CONSTRAINT fk_distributormaster_zone FOREIGN KEY (zoneid) REFERENCES zonemaster (zoneid),
    CONSTRAINT fk_distributormaster_region FOREIGN KEY (regionid) REFERENCES regionmaster (regionid),
    CONSTRAINT fk_distributormaster_area FOREIGN KEY (areaid) REFERENCES areamaster (areaid),
    CONSTRAINT fk_distributormaster_state FOREIGN KEY (stateid) REFERENCES statemaster (stateid),
    CONSTRAINT fk_distributormaster_channel FOREIGN KEY (channelid) REFERENCES channelmaster (channelid),
    CONSTRAINT fk_distributormaster_customerclassification FOREIGN KEY (customerclassificationid) REFERENCES customerclassificationmaster (customerclassificationid),
    CONSTRAINT fk_distributormaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS dealermaster (
    dealerid                   serial         PRIMARY KEY,
    dealercode                 varchar(20)    NOT NULL,
    dealername                 varchar(150)   NOT NULL,
    distributorid              integer        NOT NULL,
    tseid                      integer,
    psrid                      integer,
    zoneid                     integer        NOT NULL,
    regionid                   integer        NOT NULL,
    areaid                     integer,
    stateid                    integer        NOT NULL,
    channelid                  integer        NOT NULL,
    customerclassificationid   integer        NOT NULL,
    salesdistrictcode          varchar(20)    NOT NULL,
    salesdistrictname          varchar(100),
    ownerfirstname             varchar(100),
    ownerlastname              varchar(100),
    mobileno                   varchar(20),
    phoneno                    varchar(20),
    email                      varchar(150),
    address                    varchar(200),
    cityname                   varchar(100),
    pincode                    varchar(20),
    grade                      varchar(20),
    pricegroupcode             varchar(20),
    pricegroupname             varchar(100),
    paymenttermscode           varchar(20),
    paymenttermsname           varchar(100),
    customergroupcode          varchar(20),
    customergroupname          varchar(100),
    deliveryplantcode          varchar(20),
    deliveryplantname          varchar(100),
    expectedsale               numeric(14,2),
    salesempcode               varchar(20),
    salesempname               varchar(150),
    startdate                  date,
    enddate                    date,
    remark                     varchar(255),
    dmsstatus                  varchar(20),
    dmsmodifiedat              timestamp,
    gstno                      varchar(20),
    panno                      varchar(20),
    outletclassificationcode   varchar(20),
    outletclassificationname   varchar(100),
    vicinitycode               varchar(20),
    vicinityname               varchar(100),
    typeofsalescode            varchar(20),
    typeofsalesname            varchar(100),
    atossurveyno               varchar(50),
    channelheadcode            varchar(20),
    channelheadname            varchar(150),
    channelkamcode             varchar(20),
    channelkamname             varchar(150),
    lastimportbatchid          bigint,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_dealermaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_dealermaster_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT chk_dealermaster_expectedsale CHECK (expectedsale IS NULL OR expectedsale >= 0),
    CONSTRAINT chk_dealermaster_dates CHECK (enddate IS NULL OR startdate IS NULL OR enddate >= startdate),
    CONSTRAINT fk_dealermaster_distributor FOREIGN KEY (distributorid) REFERENCES distributormaster (distributorid),
    CONSTRAINT fk_dealermaster_tse FOREIGN KEY (tseid) REFERENCES tsemaster (tseid),
    CONSTRAINT fk_dealermaster_psr FOREIGN KEY (psrid) REFERENCES psrmaster (psrid),
    CONSTRAINT fk_dealermaster_zone FOREIGN KEY (zoneid) REFERENCES zonemaster (zoneid),
    CONSTRAINT fk_dealermaster_region FOREIGN KEY (regionid) REFERENCES regionmaster (regionid),
    CONSTRAINT fk_dealermaster_area FOREIGN KEY (areaid) REFERENCES areamaster (areaid),
    CONSTRAINT fk_dealermaster_state FOREIGN KEY (stateid) REFERENCES statemaster (stateid),
    CONSTRAINT fk_dealermaster_channel FOREIGN KEY (channelid) REFERENCES channelmaster (channelid),
    CONSTRAINT fk_dealermaster_customerclassification FOREIGN KEY (customerclassificationid) REFERENCES customerclassificationmaster (customerclassificationid),
    CONSTRAINT fk_dealermaster_lastimportbatch FOREIGN KEY (lastimportbatchid) REFERENCES importbatchmaster (importbatchid)
);

CREATE TABLE IF NOT EXISTS distributorassignmenthistory (
    distributorassignmenthistoryid bigserial      PRIMARY KEY,
    distributorid              integer        NOT NULL,
    gmid                       integer,
    zmid                       integer,
    rmid                       integer,
    asmid                      integer,
    effectivefrom              date           NOT NULL,
    effectiveto                date,
    importbatchid              bigint         NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_distributorassignmenthistory_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT chk_distributorassignmenthistory_effective CHECK (effectiveto IS NULL OR effectiveto >= effectivefrom),
    CONSTRAINT fk_distributorassignmenthistory_distributor FOREIGN KEY (distributorid) REFERENCES distributormaster (distributorid),
    CONSTRAINT fk_distributorassignmenthistory_gm FOREIGN KEY (gmid) REFERENCES gmmaster (gmid),
    CONSTRAINT fk_distributorassignmenthistory_zm FOREIGN KEY (zmid) REFERENCES zmmaster (zmid),
    CONSTRAINT fk_distributorassignmenthistory_rm FOREIGN KEY (rmid) REFERENCES rmmaster (rmid),
    CONSTRAINT fk_distributorassignmenthistory_asm FOREIGN KEY (asmid) REFERENCES asmmaster (asmid),
    CONSTRAINT fk_distributorassignmenthistory_importbatch FOREIGN KEY (importbatchid) REFERENCES importbatchmaster (importbatchid)
);

-- append-only: rows are never updated or retracted, so it keeps createdby + createdat only
CREATE TABLE IF NOT EXISTS importerrorlog (
    importerrorlogid           bigserial      PRIMARY KEY,
    importbatchid              bigint         NOT NULL,
    rownumber                  integer        NOT NULL,
    recordcode                 varchar(20),
    fieldname                  varchar(64),
    errorcode                  varchar(30)    NOT NULL,
    rawvalue                   varchar(255),
    message                    varchar(500)   NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    CONSTRAINT chk_importerrorlog_errorcode CHECK (errorcode IN ('missing_required', 'invalid_value', 'invalid_mobile', 'duplicate_code', 'unknown_salesdistrict', 'unknown_reference')),
    CONSTRAINT fk_importerrorlog_importbatch FOREIGN KEY (importbatchid) REFERENCES importbatchmaster (importbatchid)
);

-- Login tables for Super Admin only (added 2026-11-27, task-04). Every other role
-- logs in through the .NET team's central user management (CUM) API.

CREATE TABLE IF NOT EXISTS usermaster (
    userid                     serial         PRIMARY KEY,
    username                   varchar(64)    NOT NULL,
    fullname                   varchar(150)   NOT NULL,
    rolecode                   varchar(30)    NOT NULL,
    passwordhash               varchar(100)   NOT NULL,
    failedlogins               smallint       DEFAULT 0 NOT NULL,
    lockeduntil                timestamp,
    lastloginat                timestamp,
    isactive                   smallint       DEFAULT 1 NOT NULL,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_usermaster_rolecode CHECK (rolecode IN ('SUPERADMIN')),
    CONSTRAINT chk_usermaster_failedlogins CHECK (failedlogins >= 0),
    CONSTRAINT chk_usermaster_isactive CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_usermaster_isdeleted CHECK (isdeleted IN (0, 1))
);

CREATE TABLE IF NOT EXISTS authsession (
    authsessionid              bigserial      PRIMARY KEY,
    userid                     integer        NOT NULL,
    refreshtokenhash           varchar(64)    NOT NULL,
    generation                 integer        DEFAULT 1 NOT NULL,
    useragent                  varchar(255),
    ipaddress                  varchar(64),
    expiresat                  timestamp      NOT NULL,
    revokedat                  timestamp,
    createdby                  integer        DEFAULT 1 NOT NULL,
    createdat                  timestamp      DEFAULT now() NOT NULL,
    updatedby                  integer        DEFAULT 1 NOT NULL,
    updatedat                  timestamp      DEFAULT now() NOT NULL,
    isdeleted                  smallint       DEFAULT 0 NOT NULL,
    CONSTRAINT chk_authsession_generation CHECK (generation >= 1),
    CONSTRAINT chk_authsession_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_authsession_user FOREIGN KEY (userid) REFERENCES usermaster (userid)
);

-- -----------------------------------------------------------------------------
-- 2. INDEXES
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_importbatchmaster_type_status
    ON importbatchmaster (batchtype, status, createdat DESC);

CREATE INDEX IF NOT EXISTS idx_importbatchmaster_filehash
    ON importbatchmaster (filehash);

CREATE UNIQUE INDEX IF NOT EXISTS uq_zonemaster_zonecode
    ON zonemaster (zonecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_zonemaster_lastimportbatchid
    ON zonemaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_regionmaster_regioncode
    ON regionmaster (regioncode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_regionmaster_zoneid
    ON regionmaster (zoneid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_regionmaster_lastimportbatchid
    ON regionmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_areamaster_areacode
    ON areamaster (areacode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_areamaster_regionid
    ON areamaster (regionid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_areamaster_lastimportbatchid
    ON areamaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statemaster_statecode
    ON statemaster (statecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_statemaster_lastimportbatchid
    ON statemaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channelmaster_channelcode
    ON channelmaster (channelcode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_channelmaster_lastimportbatchid
    ON channelmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customerclassificationmaster_customerclassificationcode
    ON customerclassificationmaster (customerclassificationcode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_customerclassificationmaster_lastimportbatchid
    ON customerclassificationmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_gmmaster_employeecode
    ON gmmaster (employeecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_gmmaster_lastimportbatchid
    ON gmmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_zmmaster_employeecode
    ON zmmaster (employeecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_zmmaster_gmid
    ON zmmaster (gmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_zmmaster_lastimportbatchid
    ON zmmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rmmaster_employeecode
    ON rmmaster (employeecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_rmmaster_zmid
    ON rmmaster (zmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_rmmaster_gmid
    ON rmmaster (gmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_rmmaster_lastimportbatchid
    ON rmmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_asmmaster_employeecode
    ON asmmaster (employeecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_asmmaster_rmid
    ON asmmaster (rmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_asmmaster_zmid
    ON asmmaster (zmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_asmmaster_gmid
    ON asmmaster (gmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_asmmaster_lastimportbatchid
    ON asmmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tsemaster_employeecode
    ON tsemaster (employeecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_tsemaster_asmid
    ON tsemaster (asmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_tsemaster_rmid
    ON tsemaster (rmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_tsemaster_zmid
    ON tsemaster (zmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_tsemaster_gmid
    ON tsemaster (gmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_tsemaster_lastimportbatchid
    ON tsemaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_psrmaster_employeecode
    ON psrmaster (employeecode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_psrmaster_tseid
    ON psrmaster (tseid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_psrmaster_asmid
    ON psrmaster (asmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_psrmaster_rmid
    ON psrmaster (rmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_psrmaster_zmid
    ON psrmaster (zmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_psrmaster_gmid
    ON psrmaster (gmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_psrmaster_lastimportbatchid
    ON psrmaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_distributormaster_distributorcode
    ON distributormaster (distributorcode) WHERE isdeleted = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_distributormaster_salesdistrictcode
    ON distributormaster (salesdistrictcode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_parentdistributorid
    ON distributormaster (parentdistributorid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_gmid
    ON distributormaster (gmid, isactive) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_zmid
    ON distributormaster (zmid, isactive) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_rmid
    ON distributormaster (rmid, isactive) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_asmid
    ON distributormaster (asmid, isactive) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_zoneid
    ON distributormaster (zoneid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_regionid
    ON distributormaster (regionid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_stateid
    ON distributormaster (stateid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_channelid
    ON distributormaster (channelid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_customerclassificationid
    ON distributormaster (customerclassificationid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_areaid
    ON distributormaster (areaid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributormaster_lastimportbatchid
    ON distributormaster (lastimportbatchid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dealermaster_dealercode
    ON dealermaster (dealercode) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_distributorid
    ON dealermaster (distributorid, isactive) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_tseid
    ON dealermaster (tseid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_psrid
    ON dealermaster (psrid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_zoneid
    ON dealermaster (zoneid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_regionid
    ON dealermaster (regionid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_stateid
    ON dealermaster (stateid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_channelid
    ON dealermaster (channelid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_customerclassificationid
    ON dealermaster (customerclassificationid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_areaid
    ON dealermaster (areaid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_dealermaster_lastimportbatchid
    ON dealermaster (lastimportbatchid);

CREATE INDEX IF NOT EXISTS idx_distributorassignmenthistory_distributorid
    ON distributorassignmenthistory (distributorid, effectivefrom DESC) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributorassignmenthistory_gmid
    ON distributorassignmenthistory (gmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributorassignmenthistory_zmid
    ON distributorassignmenthistory (zmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributorassignmenthistory_rmid
    ON distributorassignmenthistory (rmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributorassignmenthistory_asmid
    ON distributorassignmenthistory (asmid) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_distributorassignmenthistory_importbatchid
    ON distributorassignmenthistory (importbatchid);

CREATE INDEX IF NOT EXISTS idx_importerrorlog_importbatchid
    ON importerrorlog (importbatchid, rownumber);

CREATE UNIQUE INDEX IF NOT EXISTS uq_usermaster_username
    ON usermaster (username) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_authsession_userid
    ON authsession (userid) WHERE revokedat IS NULL AND isdeleted = 0;

-- -----------------------------------------------------------------------------
-- 3. ROLLBACK  (commented; children before parents. Uncomment only to undo.)
-- -----------------------------------------------------------------------------

-- DROP TABLE IF EXISTS authsession;
-- DROP TABLE IF EXISTS usermaster;
-- DROP TABLE IF EXISTS importerrorlog;
-- DROP TABLE IF EXISTS distributorassignmenthistory;
-- DROP TABLE IF EXISTS dealermaster;
-- DROP TABLE IF EXISTS distributormaster;
-- DROP TABLE IF EXISTS psrmaster;
-- DROP TABLE IF EXISTS tsemaster;
-- DROP TABLE IF EXISTS asmmaster;
-- DROP TABLE IF EXISTS rmmaster;
-- DROP TABLE IF EXISTS zmmaster;
-- DROP TABLE IF EXISTS gmmaster;
-- DROP TABLE IF EXISTS customerclassificationmaster;
-- DROP TABLE IF EXISTS channelmaster;
-- DROP TABLE IF EXISTS statemaster;
-- DROP TABLE IF EXISTS areamaster;
-- DROP TABLE IF EXISTS regionmaster;
-- DROP TABLE IF EXISTS zonemaster;
-- DROP TABLE IF EXISTS importbatchmaster;

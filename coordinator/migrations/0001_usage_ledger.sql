-- The usage ledger. Usage is whole requests and whole bytes, so every count
-- is a bigint that cannot go negative and no column here is able to round.

-- One row per meter, holding nothing but its id. It is the row an ingest
-- locks, so batches from one meter are applied one at a time while every
-- other meter carries on.
create table usage_meter (
    meter_id uuid primary key
);

-- One applied batch. The primary key gives each sequence number of a meter
-- to one batch, and the unique batch_id gives each batch id to one batch
-- across all meters.
create table usage_batch (
    meter_id uuid not null references usage_meter (meter_id),
    seq bigint not null check (seq >= 1),
    batch_id uuid not null unique,
    -- SHA-256 of the batch as it was sent: tells a resend from a different batch.
    digest bytea not null check (octet_length(digest) = 32),
    primary key (meter_id, seq)
);

-- The lines of an applied batch. The primary key keeps one line per account
-- and device in a batch, and the unique line_no gives each position in a
-- batch to one line.
create table usage_line (
    batch_id uuid not null references usage_batch (batch_id),
    -- Position of the line in its batch, from 1: the order is part of what was sent.
    line_no bigint not null check (line_no >= 1),
    account_id uuid not null,
    device_id uuid not null,
    requests bigint not null check (requests >= 0),
    bytes_up bigint not null check (bytes_up >= 0),
    bytes_down bigint not null check (bytes_down >= 0),
    primary key (batch_id, account_id, device_id),
    unique (batch_id, line_no),
    check (requests > 0 or bytes_up > 0 or bytes_down > 0)
);

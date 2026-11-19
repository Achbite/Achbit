PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;

BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY NOT NULL CHECK(length(session_id) > 0),
    display_title TEXT NOT NULL CHECK(length(display_title) > 0),
    initial_profile_id TEXT,
    created_at TEXT NOT NULL CHECK(length(created_at) > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS session_workspace_bindings (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    workspace_id TEXT NOT NULL CHECK(length(workspace_id) > 0),
    display_name TEXT NOT NULL CHECK(length(display_name) > 0),
    PRIMARY KEY(session_id, position),
    UNIQUE(session_id, workspace_id)
) STRICT;

CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) > 0),
    event_type TEXT NOT NULL CHECK(length(event_type) > 0),
    run_id TEXT,
    call_id TEXT,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    occurred_at TEXT NOT NULL CHECK(length(occurred_at) > 0),
    PRIMARY KEY(session_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS session_commands (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    command_id TEXT NOT NULL CHECK(length(command_id) > 0),
    command_json TEXT NOT NULL CHECK(json_valid(command_json)),
    reply_json TEXT NOT NULL CHECK(json_valid(reply_json)),
    committed_revision INTEGER NOT NULL CHECK(committed_revision >= 0),
    committed_at TEXT NOT NULL CHECK(length(committed_at) > 0),
    PRIMARY KEY(session_id, command_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_run_settlement
    ON session_events(session_id, run_id)
    WHERE event_type = 'run.settled';

CREATE UNIQUE INDEX IF NOT EXISTS one_run_finishing
    ON session_events(session_id, run_id)
    WHERE event_type = 'run.finishing';

CREATE UNIQUE INDEX IF NOT EXISTS one_run_runtime_release
    ON session_events(session_id, run_id)
    WHERE event_type = 'run.runtime.released';

CREATE INDEX IF NOT EXISTS session_events_run_idx
    ON session_events(session_id, run_id, sequence);

CREATE INDEX IF NOT EXISTS session_events_call_idx
    ON session_events(session_id, call_id, sequence);

COMMIT;

CREATE TABLE IF NOT EXISTS conversation_titles (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES session_catalog(session_id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source IN ('initial', 'generated', 'manual'))
) STRICT;

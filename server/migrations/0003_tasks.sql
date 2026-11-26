-- Long-running tool calls answered as tasks (MCP extension io.modelcontextprotocol/tasks).
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,          -- random, unguessable
  tool             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'working'
                   CHECK (status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')),
  input            TEXT NOT NULL DEFAULT '{}', -- JSON tool arguments
  result           TEXT,                       -- JSON CallToolResult when completed
  error            TEXT,                       -- message when failed
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ttl_ms           INTEGER,                    -- kept this long after created_at; NULL = no limit
  poll_interval_ms INTEGER
);

CREATE INDEX tasks_created_at ON tasks (created_at);

-- 'full': agents (MCP, session hook, setup). 'backup': the GitHub Action, limited to /export routes.
ALTER TABLE devices ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'backup'));

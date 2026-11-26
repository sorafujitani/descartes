-- The current Git tree per scope, so queries join a table instead of binding the whole tree as JSON.
-- tree_state.version identifies the tree these rows describe; readers with another tree must not use them.
-- Keep each complete statement on one line for D1's exec API.
CREATE TABLE current_docs (scope TEXT NOT NULL, id TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (scope, id));
CREATE INDEX current_docs_sha ON current_docs(scope, sha);
CREATE TABLE tree_state (scope TEXT PRIMARY KEY, version TEXT NOT NULL);

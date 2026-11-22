-- Derived, credential-scoped immutable Git blobs. GitHub remains the source of truth.
-- Keep each complete statement on one line for D1's exec API (including trigger bodies).
CREATE TABLE search_blobs (rowid INTEGER PRIMARY KEY, scope TEXT NOT NULL, sha TEXT NOT NULL, title TEXT NOT NULL, normalized_title TEXT NOT NULL, markdown TEXT NOT NULL, search_text TEXT NOT NULL, UNIQUE(scope, sha));
CREATE VIRTUAL TABLE search_fts USING fts5(search_text, content='search_blobs', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER search_blobs_insert AFTER INSERT ON search_blobs BEGIN INSERT INTO search_fts(rowid, search_text) VALUES (new.rowid, new.search_text); END;
CREATE TRIGGER search_blobs_delete AFTER DELETE ON search_blobs BEGIN INSERT INTO search_fts(search_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text); END;

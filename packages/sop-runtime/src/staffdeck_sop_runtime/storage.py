from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Protocol

from staffdeck_sop_core import SopCoreError, SopDefinition, SopState


class DefinitionStore(Protocol):
    def get(self, sop_id: str, version: str | None = None) -> SopDefinition: ...
    def put(self, definition: SopDefinition) -> SopDefinition: ...


class StateStore(Protocol):
    def read(self, session_id: str) -> SopState | None: ...
    def create(self, state: SopState) -> SopState: ...
    def compare_and_swap(self, session_id: str, expected_revision: int, state: SopState) -> SopState: ...


class SqliteStore:
    def __init__(self, path: str | Path = ":memory:") -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._connection = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA busy_timeout=30000")
        self._connection.executescript("""
            CREATE TABLE IF NOT EXISTS sop_definitions (
                sop_id TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL,
                published_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                UNIQUE (sop_id, version)
            );
            CREATE TABLE IF NOT EXISTS sop_sessions (
                session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sop_session_definitions (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sop_requests (
                session_id TEXT NOT NULL, request_id TEXT NOT NULL,
                input TEXT NOT NULL, response TEXT NOT NULL,
                PRIMARY KEY (session_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS sop_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL, revision INTEGER NOT NULL,
                operation TEXT NOT NULL, payload TEXT NOT NULL
            );
        """)

    @contextmanager
    def transaction(self):
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                yield self
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise

    def close(self):
        with self._lock:
            self._connection.close()

    def get(self, sop_id: str, version: str | None = None) -> SopDefinition:
        with self._lock:
            query = "SELECT payload FROM sop_definitions WHERE sop_id = ?"
            args = (sop_id,)
            if version:
                query += " AND version = ?"
                args += (version,)
            row = self._connection.execute(query + " ORDER BY published_sequence DESC LIMIT 1", args).fetchone()
            if row is None:
                raise SopCoreError("SOP_NOT_FOUND", f"SOP definition not found: {sop_id}@{version or 'latest'}")
            return SopDefinition.from_value(json.loads(row["payload"]))

    def put(self, definition: SopDefinition) -> SopDefinition:
        payload = json.dumps(definition.to_dict(), sort_keys=True)
        with self._lock:
            old = self._connection.execute("SELECT payload FROM sop_definitions WHERE sop_id=? AND version=?", (definition.sop_id, definition.version)).fetchone()
            if old and old["payload"] != payload:
                raise SopCoreError("SOP_VERSION_CONFLICT", "published versions are immutable")
            self._connection.execute("INSERT OR IGNORE INTO sop_definitions(sop_id,version,payload) VALUES (?,?,?)", (definition.sop_id, definition.version, payload))
        return definition

    def read(self, session_id: str) -> SopState | None:
        with self._lock:
            row = self._connection.execute("SELECT payload FROM sop_sessions WHERE session_id=?", (session_id,)).fetchone()
            return SopState.from_dict(json.loads(row["payload"])) if row else None

    def create(self, state: SopState) -> SopState:
        with self._lock:
            self._connection.execute("INSERT INTO sop_sessions VALUES (?,?,?)", (state.session_id, state.revision, json.dumps(state.to_dict())))
        return state

    def bind_definition(self, session_id: str, definition: SopDefinition):
        with self._lock:
            self._connection.execute("INSERT INTO sop_session_definitions VALUES (?,?)", (session_id, json.dumps(definition.to_dict())))

    def session_definition(self, session_id: str):
        with self._lock:
            row = self._connection.execute("SELECT payload FROM sop_session_definitions WHERE session_id=?", (session_id,)).fetchone()
        if row is None:
            raise SopCoreError("SOP_NOT_FOUND", "session definition snapshot is missing")
        return SopDefinition.from_value(json.loads(row["payload"]))

    def definitions(self):
        with self._lock:
            rows = self._connection.execute("SELECT payload FROM sop_definitions ORDER BY published_sequence").fetchall()
        definitions = {}
        for row in rows:
            definition = SopDefinition.from_value(json.loads(row["payload"]))
            definitions[definition.sop_id] = definition
            definitions[(definition.sop_id, definition.version)] = definition
        return definitions

    def compare_and_swap(self, session_id: str, expected_revision: int, state: SopState) -> SopState:
        if state.session_id != session_id:
            raise SopCoreError("SESSION_SCOPE_MISMATCH", "state belongs to another session")
        with self._lock:
            state.revision = expected_revision + 1
            result = self._connection.execute("UPDATE sop_sessions SET revision=?,payload=? WHERE session_id=? AND revision=?", (state.revision, json.dumps(state.to_dict()), session_id, expected_revision))
            if result.rowcount != 1:
                raise SopCoreError("SOP_REVISION_CONFLICT", "session revision is stale")
        return state

    def get_request(self, session_id: str, request_id: str, input: dict) -> dict | None:
        row = self._connection.execute("SELECT input,response FROM sop_requests WHERE session_id=? AND request_id=?", (session_id, request_id)).fetchone()
        if row and row["input"] != json.dumps(input, sort_keys=True):
            raise SopCoreError("SOP_REQUEST_CONFLICT", "request id belongs to another payload")
        return json.loads(row["response"]) if row else None

    def put_request(self, session_id: str, request_id: str, input: dict, response: dict) -> None:
        self._connection.execute("INSERT INTO sop_requests VALUES (?,?,?,?)", (session_id, request_id, json.dumps(input, sort_keys=True), json.dumps(response)))

    def event(self, session_id: str, operation: str, state: SopState) -> None:
        self._connection.execute("INSERT INTO sop_events(session_id,revision,operation,payload) VALUES (?,?,?,?)", (session_id, state.revision, operation, json.dumps(state.to_dict())))


class MemoryStore(SqliteStore):
    """Ephemeral store with the same atomic semantics as the persistent store."""
    def __init__(self):
        super().__init__(":memory:")

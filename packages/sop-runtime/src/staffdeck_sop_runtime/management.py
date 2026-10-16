"""Portable definition management; identity and model execution belong to hosts."""
from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from staffdeck_sop_core import SopCoreError, SopDefinition, SopState, prepare
from staffdeck_sop_core.nesting import expand
from .features import SopFeatures


def now():
    return datetime.now(timezone.utc).isoformat()


class ManagementService:
    def __init__(self, store, snapshot, features=None):
        self.features = features or SopFeatures()
        self.store, self.snapshot = store, snapshot
        with store._lock:
            store._connection.executescript("""
                CREATE TABLE IF NOT EXISTS sop_management (
                    sop_id TEXT PRIMARY KEY, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sop_drafts (
                    draft_id TEXT PRIMARY KEY, sop_id TEXT NOT NULL, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sop_generation_jobs (
                    job_id TEXT PRIMARY KEY, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sop_generation_events (
                    job_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(job_id, sequence)
                );
            """)

    def _get(self, table, key, value):
        row = self.store._connection.execute(
            f"SELECT payload FROM {table} WHERE {key}=?", (value,)
        ).fetchone()
        if row is None:
            raise SopCoreError("SOP_MANAGEMENT_NOT_FOUND", "Management resource not found")
        return json.loads(row["payload"])

    def _put(self, table, key, value, payload, **extra):
        columns = [key, *extra, "payload"]
        values = [value, *extra.values(), json.dumps(payload, sort_keys=True)]
        self.store._connection.execute(
            f"INSERT OR REPLACE INTO {table} ({','.join(columns)}) "
            f"VALUES ({','.join('?' for _ in columns)})", values
        )

    def rows(self):
        return [json.loads(row["payload"]) for row in self.store._connection.execute(
            "SELECT payload FROM sop_management ORDER BY sop_id"
        ).fetchall()]

    def available(self, sop_id):
        row = self.store._connection.execute(
            "SELECT payload FROM sop_management WHERE sop_id=?", (sop_id,)
        ).fetchone()
        # Original snapshot publication is still supported by the StaffDeck adapter.
        return row is None or json.loads(row["payload"])["status"] == "published"

    def definition(self, sop_id, version=None):
        row = self._get("sop_management", "sop_id", sop_id)
        if row["status"] != "published" or not row.get("published_version"):
            raise SopCoreError("SOP_UNPUBLISHED", "SOP is not available for new executions")
        return self.store.get(sop_id, version or row["published_version"])

    def catalog(self):
        return {"definitions": [self.definition(row["sop_id"]).to_dict()
                                for row in self.rows() if row["status"] == "published"]}

    def validate(self, content, *, publication=False):
        value = deepcopy(content)
        if not isinstance(value, dict):
            raise SopCoreError("SOP_DEFINITION_INVALID", "SOP content must be an object")
        for node in value.get("nodes", []):
            if node.get("assignee_ref") == "pilotdeck:owner":
                node["assignee_user_id"] = "pilotdeck:owner"
            if node.get("type") == "subflow" and publication:
                child = self.definition(node.get("sub_sop_id"), node.get("sub_sop_version"))
                node["sub_sop_version"] = child.version
        definition = SopDefinition.from_value(value)
        self.features.check_definition(definition)
        if publication:
            catalog = self.store.definitions()
            catalog[definition.sop_id] = definition
            catalog[(definition.sop_id, definition.version)] = definition
            expanded = expand(definition, catalog)
            self.features.check_definition(expanded)
            prepare(expanded, SopState("validate", definition.sop_id, definition.version))
        else:
            # Unresolved child references may be edited, but publication must resolve them.
            prepare(definition, SopState("validate", definition.sop_id, definition.version))
        return value

    def call(self, operation, data):
        if not isinstance(operation, str) or not isinstance(data, dict):
            raise SopCoreError("SOP_DEFINITION_INVALID", "Management requires an operation and an object input")
        with self.store.transaction():
            try:
                return self._call(operation, data)
            except (KeyError, TypeError, AttributeError) as error:
                raise ValueError("Management input is missing a required field or has an invalid type") from error

    def _call(self, operation, data):
        sop_id = data.get("sopId")
        if operation == "features":
            return self.features.to_dict()
        if not self.features.version_management and operation in {"list_versions", "get_version", "rollback"}:
            raise SopCoreError("SOP_FEATURE_DISABLED", "SOP version management module is disabled")
        if operation == "list":
            rows = [row for row in self.rows() if row["status"] != "deleted"]
            drafts = [json.loads(row["payload"]) for row in self.store._connection.execute(
                "SELECT payload FROM sop_drafts ORDER BY draft_id"
            ).fetchall()]
            return {"data": rows, "drafts": [d for d in drafts if d["status"] == "draft"]}
        if operation == "validate":
            return {"content": self.validate(data["content"], publication=data.get("publication", False))}
        if operation in {"create", "import"}:
            content = self.validate(data["content"])
            definition = SopDefinition.from_value(content)
            sop_id = sop_id or definition.sop_id
            if definition.sop_id != sop_id:
                raise SopCoreError("SOP_ID_MISMATCH", "Draft belongs to another SOP")
            try:
                row = self._get("sop_management", "sop_id", sop_id)
                if row["status"] == "deleted":
                    raise SopCoreError("SOP_DELETED", "Deleted SOP IDs cannot be reused")
            except SopCoreError as error:
                if error.code != "SOP_MANAGEMENT_NOT_FOUND":
                    raise
                row = {"id": sop_id, "sop_id": sop_id, "skill_id": sop_id,
                       "status": "draft", "published_version": None}
                self._put("sop_management", "sop_id", sop_id, row)
            draft_id = uuid4().hex
            draft = {"id": draft_id, "draft_id": draft_id, "sop_id": sop_id,
                     "skill_id": sop_id, "content": content, "name": definition.name,
                     "version": definition.version, "status": "draft", "revision": 0,
                     "etag": "0", "updated_at": now(), "base_version": data.get("baseVersion")}
            self._put("sop_drafts", "draft_id", draft_id, draft, sop_id=sop_id)
            if operation == "import" and data.get("publish"):
                return self._call("publish", {"sopId": sop_id, "draftId": draft_id, "expectedRevision": 0})
            return draft
        if operation in {"get_draft", "replace_draft", "publish"}:
            draft = self._get("sop_drafts", "draft_id", data["draftId"])
            if draft["sop_id"] != sop_id:
                raise SopCoreError("SOP_SCOPE_MISMATCH", "Draft belongs to another SOP")
            if operation == "get_draft":
                return draft
            if self._get("sop_management", "sop_id", sop_id)["status"] == "deleted":
                raise SopCoreError("SOP_DELETED", "Deleted SOPs cannot be changed")
            expected = data.get("expectedRevision", data.get("etag"))
            if str(expected) != str(draft["revision"]):
                raise SopCoreError("SOP_DRAFT_REVISION_CONFLICT", "Draft changed; reload before writing")
            if draft["status"] != "draft":
                raise SopCoreError("SOP_DRAFT_CLOSED", "Draft has already been published")
            if operation == "replace_draft":
                content = self.validate(data["content"])
                definition = SopDefinition.from_value(content)
                if definition.sop_id != sop_id:
                    raise SopCoreError("SOP_ID_MISMATCH", "Draft SOP ID cannot change")
                draft.update(content=content, name=definition.name, version=definition.version,
                             revision=draft["revision"] + 1, updated_at=now())
                draft["etag"] = str(draft["revision"])
                self._put("sop_drafts", "draft_id", draft["draft_id"], draft, sop_id=sop_id)
                return draft
            content = self.validate(draft["content"], publication=True)
            if not self.features.version_management:
                content = {**content, "version": "snapshot-" + uuid4().hex}
            definition = self.snapshot({"content": content, "source": "portable-management"})
            try:
                existing = self.store.get(sop_id, definition.version)
            except SopCoreError:
                existing = None
            if existing:
                if existing.content != definition.content or existing.capability_requirements != definition.capability_requirements:
                    raise SopCoreError("SOP_VERSION_CONFLICT", "Published versions are immutable")
                definition = existing
            self.store.put(definition)
            row = {"id": sop_id, "sop_id": sop_id, "skill_id": sop_id,
                   "name": definition.name, "version": definition.version,
                   "published_version": definition.version, "status": "published",
                   "content": definition.content, "updated_at": now()}
            self._put("sop_management", "sop_id", sop_id, row)
            draft.update(status="published", updated_at=now())
            self._put("sop_drafts", "draft_id", draft["draft_id"], draft, sop_id=sop_id)
            return row
        if operation == "list_versions":
            return {"data": [self.version_row(value) for key, value in self.store.definitions().items()
                             if isinstance(key, tuple) and key[0] == sop_id]}
        if operation == "get_version":
            return self.version_row(self.store.get(sop_id, data["version"]))
        if operation in {"rollback", "archive", "delete"}:
            row = self._get("sop_management", "sop_id", sop_id)
            if row["status"] == "deleted":
                raise SopCoreError("SOP_DELETED", "SOP was deleted")
            if operation == "rollback":
                definition = self.store.get(sop_id, data["version"])
                self.validate(definition.content, publication=True)
                row.update(content=definition.content, name=definition.name,
                           version=definition.version, published_version=definition.version, status="published")
            else:
                row["status"] = "archived" if operation == "archive" else "deleted"
                if operation == "delete":
                    self.store._connection.execute("DELETE FROM sop_drafts WHERE sop_id=?", (sop_id,))
            row["updated_at"] = now()
            self._put("sop_management", "sop_id", sop_id, row)
            return row
        if operation.startswith("job_"):
            return self.job(operation, data)
        raise SopCoreError("SOP_MANAGEMENT_OPERATION_UNSUPPORTED", "Unknown management operation")

    @staticmethod
    def version_row(definition):
        return {**definition.to_dict(), "id": definition.sop_id, "skill_id": definition.sop_id,
                "updated_at": definition.published_at, "status": "published"}

    def event(self, job_id, event, data):
        sequence = self.store._connection.execute(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM sop_generation_events WHERE job_id=?", (job_id,)
        ).fetchone()[0]
        value = {"sequence": sequence, "event": event, "data": data}
        self.store._connection.execute("INSERT INTO sop_generation_events VALUES (?,?,?)",
                                       (job_id, sequence, json.dumps(value)))
        return value

    def job(self, operation, data):
        if operation == "job_recover":
            interrupted = []
            for row in self.store._connection.execute("SELECT payload FROM sop_generation_jobs").fetchall():
                pending = json.loads(row["payload"])
                if pending["status"] in {"queued", "running"} and pending.get("worker_id") != data["workerId"]:
                    interrupted.append(self.job("job_interrupt", {"jobId": pending["id"],
                        "error": "Generation worker restarted; retry this task"}))
            return {"data": interrupted}
        if operation == "job_create":
            job = {"id": uuid4().hex, "status": "queued", "input": data["input"],
                   "kind": data.get("kind", "generate"), "updated_at": now()}
            self._put("sop_generation_jobs", "job_id", job["id"], job)
            self.event(job["id"], "status", {"status": "queued"})
            return job
        job = self._get("sop_generation_jobs", "job_id", data["jobId"])
        if operation == "job_get":
            return job
        if operation == "job_events":
            return {"data": [json.loads(r["payload"]) for r in self.store._connection.execute(
                "SELECT payload FROM sop_generation_events WHERE job_id=? AND sequence>? ORDER BY sequence",
                (job["id"], data.get("afterSequence", 0))).fetchall()]}
        if operation == "job_start":
            if job["status"] != "queued":
                raise SopCoreError("SOP_JOB_STATE_CONFLICT", "Job is not queued")
            job.update(status="running", worker_id=data["workerId"])
        elif operation in {"job_chunk", "job_chunk_reset"}:
            self._require_worker(job, data)
            self.event(job["id"], "chunk" if operation == "job_chunk" else "chunk_reset",
                       {"content": data["content"]} if operation == "job_chunk" else {})
            return job
        elif operation == "job_complete":
            self._require_worker(job, data)
            original = job["input"]
            content = data["content"]
            if original.get("sopId") and SopDefinition.from_value(content).sop_id != original["sopId"]:
                raise SopCoreError("SOP_ID_MISMATCH", "Generated SOP ID differs from the requested SOP")
            if original.get("draftId"):
                draft = self._call("replace_draft", {**original, "content": content})
            else:
                draft = self._call("create", {"content": content})
            job.update(status="completed", result=draft)
        elif operation in {"job_cancel", "job_fail", "job_interrupt"}:
            if job["status"] not in {"queued", "running"}:
                return job
            if operation == "job_fail":
                self._require_worker(job, data)
            job.update(status={"job_cancel": "cancelled", "job_fail": "failed", "job_interrupt": "interrupted"}[operation],
                       error=data.get("error"))
        else:
            raise SopCoreError("SOP_MANAGEMENT_OPERATION_UNSUPPORTED", "Unknown generation operation")
        job["updated_at"] = now()
        self._put("sop_generation_jobs", "job_id", job["id"], job)
        self.event(job["id"], "complete" if job["status"] == "completed" else "status", job)
        return job

    @staticmethod
    def _require_worker(job, data):
        if job["status"] != "running" or job.get("worker_id") != data.get("workerId"):
            raise SopCoreError("SOP_JOB_STATE_CONFLICT", "Job is no longer owned by this worker")

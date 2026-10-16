"""Deployment-level SOP feature policy, shared by management and execution."""
from dataclasses import dataclass
import os
from staffdeck_sop_core import SopCoreError


@dataclass(frozen=True)
class SopFeatures:
    knowledge: bool = True
    version_management: bool = True

    @classmethod
    def from_env(cls):
        def enabled(name):
            value = os.environ.get(name, "true").lower()
            if value not in {"true", "false", "1", "0"}:
                raise ValueError(f"{name} must be true or false")
            return value in {"true", "1"}
        return cls(enabled("SOP_KNOWLEDGE_ENABLED"), enabled("SOP_VERSION_MANAGEMENT_ENABLED"))

    def to_dict(self):
        return {"knowledge": self.knowledge, "versionManagement": self.version_management}

    def check_definition(self, definition):
        if not self.knowledge and (any(r.kind == "knowledge" for r in definition.capability_requirements)
            or any(node.get("knowledge_base_ids") or node.get("required_knowledge_base_ids")
                   for node in definition.content.get("nodes", []))):
            raise SopCoreError("SOP_FEATURE_DISABLED", "SOP knowledge module is disabled")

from __future__ import annotations
from pathlib import Path
import yaml


class YAMLStore:

    def __init__(self, store_dir: Path):
        self.store_dir = store_dir
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self.ref_cache_dir = store_dir / "ref_cache"
        self.ref_cache_dir.mkdir(exist_ok=True)
        self.changelog_dir = store_dir / "changelogs"
        self.changelog_dir.mkdir(exist_ok=True)
        self.patterns_path = store_dir / "patterns.json"

    def _refs_dir(self, version: str) -> Path:
        d = self.store_dir / f"refs_{version}"
        d.mkdir(exist_ok=True)
        return d

    def save_paper_card(self, ref_id: str, card: dict, version: str):
        path = self._refs_dir(version) / f"{ref_id}.yaml"
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(card, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

    def load_paper_card(self, ref_id: str, version: str) -> dict:
        path = self._refs_dir(version) / f"{ref_id}.yaml"
        if path.exists():
            with open(path, encoding="utf-8") as f:
                return yaml.safe_load(f)
        return {}

    def save_ref_cache(self, ref_id: str, full_text: str):
        path = self.ref_cache_dir / f"{ref_id}.txt"
        with open(path, "w", encoding="utf-8") as f:
            f.write(full_text)

    def load_ref_cache(self, ref_id: str) -> str:
        path = self.ref_cache_dir / f"{ref_id}.txt"
        if path.exists():
            with open(path, encoding="utf-8") as f:
                return f.read()
        return ""

    def append_changelog(self, version_from: str, version_to: str, entry: dict):
        path = self.changelog_dir / f"changelog_{version_from}_{version_to}.yaml"
        existing = []
        if path.exists():
            with open(path, encoding="utf-8") as f:
                existing = yaml.safe_load(f) or []
        existing.append(entry)
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(existing, f, allow_unicode=True, default_flow_style=False)

    def save_patterns(self, patterns: dict):
        import json
        with open(self.patterns_path, "w", encoding="utf-8") as f:
            json.dump(patterns, f, ensure_ascii=False, indent=2)

    def load_patterns(self) -> dict:
        import json
        if self.patterns_path.exists():
            with open(self.patterns_path, encoding="utf-8") as f:
                return json.load(f)
        return {}

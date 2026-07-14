from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path




def _default_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


@dataclass
class Paths:

    root: Path = field(default_factory=_default_root)
    model_suffix: str = ""


    @property
    def agents(self) -> Path: return self.root / "agents"

    @property
    def models_dir(self) -> Path: return self.root / "models"

    @property
    def pipeline(self) -> Path: return self.root / "pipeline"

    @property
    def demo(self) -> Path: return self.root / "demo"

    @property
    def config(self) -> Path: return self.root / "config"

    @property
    def eval(self) -> Path: return self.root / "eval"

    @property
    def scripts(self) -> Path: return self.root / "scripts"

    @property
    def docs(self) -> Path: return self.root / "docs"

    @property
    def outputs(self) -> Path: return self.root / "outputs"

    @property
    def logs(self) -> Path: return self.root / "logs"

    @property
    def data(self) -> "DataPaths":
        return DataPaths(self.root / "data", model_suffix=self.model_suffix)


    @property
    def out_a_og(self) -> Path: return self.outputs / "a_og"

    @property
    def out_b_incremental(self) -> Path: return self.outputs / "b_incremental"

    @property
    def out_c_oneshot(self) -> Path: return self.outputs / "c_oneshot"

    @property
    def out_race(self) -> Path: return self.outputs / "race"

    @property
    def out_obj(self) -> Path: return self.outputs / "obj"


    def cluster_dir(self, cluster_id: str) -> Path:
        return self.data.clusters_base / cluster_id

    def cluster_config(self, cluster_id: str) -> Path:
        return self.cluster_dir(cluster_id) / "cluster_config.json"

    def cluster_data_dir(self, cluster_id: str) -> Path:
        return self.data.clusters / cluster_id

    def cluster_agent_outputs(self, cluster_id: str) -> Path:
        return self.cluster_data_dir(cluster_id) / "agent_outputs"

    def cluster_output(self, cluster_id: str) -> Path:
        return self.cluster_data_dir(cluster_id) / "output"

    def refs_dir(self, cluster_id: str) -> Path:
        return self.data.references / cluster_id

    def gt_dir(self, cluster_id: str) -> Path:
        return self.data.gt_keywords / cluster_id

    def intermediates_og(self, cluster_id: str) -> Path:
        return self.data.intermediates / "og" / cluster_id

    def intermediates_balanced(self, cluster_id: str) -> Path:
        return self.data.intermediates / "balanced_rewrite_v1" / cluster_id

    def intermediates_subdir(self, sub: str, cluster_id: str) -> Path:
        return self.data.intermediates / sub / cluster_id

    def a_og_dir(self, cluster_id: str) -> Path:
        return self.out_a_og / cluster_id

    def b_dir(self, cluster_id: str) -> Path:
        return self.out_b_incremental / cluster_id

    def c_dir(self, cluster_id: str) -> Path:
        return self.out_c_oneshot / cluster_id

    def race_dir(self, cluster_id: str, judge: str) -> Path:
        return self.out_race / cluster_id / judge

    def ensure(self) -> "Paths":
        for p in [
            self.outputs, self.out_a_og, self.out_b_incremental,
            self.out_c_oneshot, self.out_race, self.out_obj,
            self.logs,
        ]:
            p.mkdir(parents=True, exist_ok=True)
        return self


@dataclass
class DataPaths:
    root: Path
    model_suffix: str = ""

    @property
    def freshqa_dir(self) -> Path: return self.root / "freshqa"

    @property
    def freshqa_questions(self) -> Path: return self.freshqa_dir / "questions.json"

    @property
    def freshqa_schema(self) -> Path: return self.freshqa_dir / "schema.json"

    @property
    def references(self) -> Path: return self.freshqa_dir / "references"

    @property
    def gt_keywords(self) -> Path: return self.root / "gt_keywords"

    @property
    def clusters_base(self) -> Path:
        return self.root / "clusters"

    @property
    def clusters(self) -> Path:
        return self.root / f"clusters{self.model_suffix}"

    @property
    def intermediates(self) -> Path:
        return self.root / f"intermediates{self.model_suffix}"




def resolve_root(explicit: Path | None = None) -> Path:
    if explicit is not None:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("V5_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    return _default_root()


def make_paths(root: Path | None = None, model_suffix: str | None = None) -> Paths:
    suf = model_suffix if model_suffix is not None else os.environ.get("V5_MODEL_SUFFIX", "")
    p = Paths(root=resolve_root(root), model_suffix=suf)
    p.ensure()
    return p



paths = make_paths()


if __name__ == "__main__":

    p = make_paths()
    print(f"[paths] root = {p.root}")
    for k in [
        "agents", "models_dir", "pipeline", "eval", "scripts", "docs",
        "outputs", "logs",
        "data.freshqa_questions", "data.freshqa_schema",
        "data.references", "data.gt_keywords", "data.clusters",
        "data.intermediates",
    ]:
        attr = p
        for part in k.split("."):
            attr = getattr(attr, part)
        print(f"  {k:30s} = {attr}")
    print(f"  cluster_dir('DR-28')           = {p.cluster_dir('DR-28')}")
    print(f"  cluster_config('DR-28')        = {p.cluster_config('DR-28')}")
    print(f"  refs_dir('DR-28')              = {p.refs_dir('DR-28')}")
    print(f"  gt_dir('DR-28')                = {p.gt_dir('DR-28')}")
    print(f"  a_og_dir('DR-28')              = {p.a_og_dir('DR-28')}")
    print(f"  race_dir('DR-28','ds-v4-pro')  = {p.race_dir('DR-28', 'ds-v4-pro')}")

from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "demo" / "agent_outputs"
REPORT_DIR = BASE_DIR.parent / "results{year}"

YAML_STORE_DIR = BASE_DIR / "og_store"
REF_CACHE_DIR = YAML_STORE_DIR / "ref_cache"
GRAPH_PERSIST_PATH = YAML_STORE_DIR / "og_graph.json"

EMBEDDING_MODEL = "all-MiniLM-L6-v2"
CHUNK_MAX_LEN = 200
CHUNK_OVERLAP_SENTENCES = 1

PROPAGATION_DECAY = {1: 1.0, 2: 0.5, 3: 0.25}
PROPAGATION_MAX_HOP = {"high": 3, "medium": 2, "low": 1}

NODE_TYPES = ["Section", "Claim", "Evidence", "Context", "Comparison", "Synthesis", "Transition", "Reference"]
EDGE_TYPES = [
    "contains", "transitions_to",
    "supports", "contradicts",
    "parallels", "deepens", "derives_from",
    "contextualizes", "compared_in",
    "supersedes", "cites", "cited_by",
]
OPERATIONS = ["CREATE", "UPDATE", "AUGMENT", "SUPERSEDE", "DELETE", "RECONTEXTUALIZE", "SPLIT"]
DIRECTIONS = ["strengthen", "neutral", "weaken"]
PRIORITY_LEVELS = ["low", "medium", "high"]

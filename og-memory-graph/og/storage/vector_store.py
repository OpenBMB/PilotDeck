from __future__ import annotations
import os
import re
from typing import Optional
import chromadb
from chromadb.config import Settings






RETRIEVAL_MODE = os.environ.get("RETRIEVAL_MODE", "hybrid").lower()


RRF_K = 60


_RERANKER_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
_RERANKER = None
_RERANKER_LOAD_TIMEOUT = 15
import subprocess
import sys
import os as _os
import pickle as _pickle



ENABLE_RERANK = _os.environ.get("OG_ENABLE_RERANK", "").strip() in ("1", "true", "yes")


def _load_reranker_in_subprocess(model_name: str, timeout: int) -> dict:
    import base64
    code = f"""
import sys, pickle, base64, os
# 关掉 low_cpu_mem_usage (避免 transformers 走 meta tensor 路径, 触发
# "Cannot copy out of meta tensor" PyTorch 兼容错误)
os.environ['LOW_CPU_MEM_USAGE'] = '0'
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'
try:
    from sentence_transformers import CrossEncoder
    # 强制 device=cpu + low_cpu_mem_usage=False 避免 meta tensor
    obj = CrossEncoder({model_name!r}, device='cpu', max_length=512)
    sys.stdout.write('OK ' + base64.b64encode(pickle.dumps(obj)).decode())
except Exception as e:
    sys.stdout.write('ERR ' + str(e))
"""
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, timeout=timeout,
            env={**_os.environ, "PYTHONWARNINGS": "ignore"},
        )
        out = (proc.stdout or "").strip()
        if out.startswith("OK "):
            return {"ok": True, "err": None, "obj_b64": out[3:]}
        if out.startswith("ERR "):
            return {"ok": False, "err": out[4:200], "obj_b64": None}
        return {"ok": False, "err": f"subprocess 未输出 OK/ERR ({out[:80]})", "obj_b64": None}
    except subprocess.TimeoutExpired:
        return {"ok": False, "err": f"subprocess timeout (>{timeout}s)", "obj_b64": None}
    except Exception as e:
        return {"ok": False, "err": f"{type(e).__name__}: {e}", "obj_b64": None}


def _get_reranker():
    global _RERANKER
    if _RERANKER is not None:
        return _RERANKER
    if _RERANKER is False:
        return None
    print(f"  [vector_store] 后台加载 reranker ({_RERANKER_NAME}, "
          f"timeout={_RERANKER_LOAD_TIMEOUT}s)...", flush=True)
    res = _load_reranker_in_subprocess(_RERANKER_NAME, _RERANKER_LOAD_TIMEOUT)
    if res["ok"] and res.get("obj_b64"):
        try:
            import base64
            _RERANKER = _pickle.loads(base64.b64decode(res["obj_b64"]))
            print(f"  [vector_store] reranker 加载成功", flush=True)
            return _RERANKER
        except Exception as e:
            print(f"  [vector_store] reranker unpickle 失败 ({e})", flush=True)
            _RERANKER = False
            return None
    err = res.get("err") or "未知错误"
    print(f"  [vector_store] reranker 不可用 ({err[:150]}), fallback to RRF-only",
          flush=True)
    _RERANKER = False
    return None



RERANK_CANDIDATE_MULTIPLIER = 5

_RERANKER_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
_RERANKER = None


def _get_reranker():
    global _RERANKER
    if _RERANKER is not None:
        return _RERANKER
    if not ENABLE_RERANK:
        _RERANKER = False
        return None
    try:
        from sentence_transformers import CrossEncoder
        _RERANKER = CrossEncoder(_RERANKER_NAME, device='cpu', max_length=128)
        return _RERANKER
    except Exception as e:

        print(f"  [vector_store] reranker 加载失败 ({type(e).__name__}: {e}), fallback to RRF-only",
              flush=True)
        _RERANKER = False
        return None



_JIEBA_READY = False


def _tokenize(text: str) -> list[str]:
    global _JIEBA_READY
    if not text:
        return []
    text = text.strip().lower()
    tokens: list[str] = []

    en_tokens = re.findall(r"[a-z0-9]+", text)
    tokens.extend(en_tokens)

    cn_chars = re.findall(r"[\u4e00-\u9fff]+", text)
    cn_text = "".join(cn_chars)
    if not cn_text:
        return tokens
    try:
        if not _JIEBA_READY:
            import jieba
            jieba.setLogLevel(20)
            _JIEBA_READY = True
        import jieba as _jieba
        for w in _jieba.cut(cn_text):
            w = w.strip()
            if w and len(w) > 0:
                tokens.append(w)
    except Exception:

        for i in range(len(cn_text) - 1):
            tokens.append(cn_text[i:i+2])
        if cn_text:
            tokens.append(cn_text[-1])
    return tokens


class VectorStore:

    def __init__(self, collection_name: str = "og_chunks"):
        self._client = chromadb.Client(Settings(anonymized_telemetry=False))
        self._collection = self._client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"},
        )
        self._embed_fn = None


        self._bm25: Optional[object] = None
        self._bm25_corpus: list[list[str]] = []
        self._bm25_chunks: list[dict] = []
        self._bm25_dirty: bool = False

    def _get_embedder(self):
        if self._embed_fn is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer("all-MiniLM-L6-v2")
            self._embed_fn = self._model.encode
        return self._embed_fn

    def _embed(self, texts: list[str]) -> list[list[float]]:
        fn = self._get_embedder()
        return fn(texts, show_progress_bar=False).tolist()



    def _bm25_add(self, ids: list[str], docs: list[str], metas: list[dict]):
        for cid, doc, meta in zip(ids, docs, metas):
            self._bm25_corpus.append(_tokenize(doc))
            self._bm25_chunks.append({"chunk_id": cid, "text": doc, "metadata": meta})
        self._bm25_dirty = True

    def _bm25_ensure_built(self):
        if not self._bm25_dirty and self._bm25 is not None:
            return
        try:
            from rank_bm25 import BM25Okapi
        except ImportError:
            return
        if not self._bm25_corpus:
            return
        self._bm25 = BM25Okapi(self._bm25_corpus)
        self._bm25_dirty = False



    @staticmethod
    def chunk_text(text: str, max_len: int = 200) -> list[str]:
        if not text or len(text.strip()) == 0:
            return []
        text = text.strip()
        if len(text) <= max_len:
            return [text]
        sentences = re.split(r'(?<=[。；.;！!？?\n])', text)
        sentences = [s.strip() for s in sentences if s.strip()]
        chunks, current = [], ""
        for sent in sentences:
            if len(current) + len(sent) > max_len and current:
                chunks.append(current)
                overlap = sentences[max(0, sentences.index(sent) - 1)] if sentences.index(sent) > 0 else ""
                current = overlap + sent if len(overlap) < 50 else sent
            else:
                current += sent
        if current:
            chunks.append(current)
        return chunks if chunks else [text]

    @staticmethod
    def data_blocks_to_chunks(data_blocks: list[dict]) -> list[str]:
        chunks = []
        for db in data_blocks:
            label = db.get("label", "")
            value = db.get("value", "")
            year = db.get("data_year", "")
            ref = db.get("source_ref", "")
            text = f"{label}: {value}"
            if year:
                text += f" ({year}年)"
            if ref:
                text += f" [来源:{ref}]"
            chunks.append(text)
        return chunks



    def add_node_chunks(self, node_id: str, content: str, data_blocks: list[dict],
                        metadata: dict, source_type: str = "report"):
        text_chunks = self.chunk_text(content)
        data_chunks = self.data_blocks_to_chunks(data_blocks)
        all_chunks = text_chunks + data_chunks
        if not all_chunks:
            return

        ids = [f"CHK-{node_id}-{i:03d}" for i in range(len(all_chunks))]
        metas = [{**metadata, "source_type": source_type, "node_id": node_id, "chunk_index": i}
                 for i in range(len(all_chunks))]
        embeddings = self._embed(all_chunks)

        self._collection.add(
            ids=ids,
            embeddings=embeddings,
            documents=all_chunks,
            metadatas=metas,
        )

        self._bm25_add(ids, all_chunks, metas)

    def add_reference_chunks(self, ref_id: str, full_text: str, card_summary: str, metadata: dict):
        all_text = f"{card_summary}\n\n{full_text}" if full_text else card_summary
        chunks = self.chunk_text(all_text, max_len=300)
        if not chunks:
            return

        ids = [f"CHK-{ref_id}-{i:03d}" for i in range(len(chunks))]
        metas = [{**metadata, "source_type": "reference", "ref_id": ref_id, "chunk_index": i}
                 for i in range(len(chunks))]
        embeddings = self._embed(chunks)

        self._collection.add(ids=ids, embeddings=embeddings, documents=chunks, metadatas=metas)
        self._bm25_add(ids, chunks, metas)



    def search(self, query: str, top_k: int = 10,
               where: Optional[dict] = None) -> list[dict]:
        mode = RETRIEVAL_MODE
        if mode == "bm25":
            return self._search_bm25_only(query, top_k, where)
        if mode == "vector":
            return self._search_vector_only(query, top_k, where)

        return self._search_hybrid(query, top_k, where)

    def _search_vector_only(self, query: str, top_k: int, where) -> list[dict]:
        embedding = self._embed([query])[0]
        kwargs = {"query_embeddings": [embedding], "n_results": top_k}
        if where:
            kwargs["where"] = where
        results = self._collection.query(**kwargs)
        return [self._format_hit(results, i, vector_score=results["distances"][0][i] if i < len(results["ids"][0]) else None)
                for i in range(len(results["ids"][0]))]

    def _search_bm25_only(self, query: str, top_k: int, where) -> list[dict]:
        self._bm25_ensure_built()
        if self._bm25 is None or not self._bm25_corpus:
            return []
        query_tokens = _tokenize(query)
        scores = self._bm25.get_scores(query_tokens)

        indices = list(range(len(self._bm25_chunks)))
        if where:
            indices = [i for i in indices
                       if all(self._bm25_chunks[i]["metadata"].get(k) == v
                              for k, v in where.items())]

        pairs = [(scores[i], i) for i in indices]
        pairs.sort(key=lambda x: -x[0])
        pairs = pairs[:top_k]
        hits = []
        for rank, (score, idx) in enumerate(pairs):
            c = self._bm25_chunks[idx]
            hits.append({
                "chunk_id": c["chunk_id"],
                "text": c["text"],
                "score": float(score),
                "bm25_score": float(score),
                "rrf_score": 1.0 / (RRF_K + rank + 1),
                "metadata": c["metadata"],
            })
        return hits

    def search_multi(self, queries: list[str], top_k_per_query: int = 15,
                     top_n: int = 30, rrf_k: int = 60,
                     rerank_query: str | None = None,
                     where: Optional[dict] = None) -> list[dict]:
        if not queries:
            return []
        queries = [q for q in queries if q and q.strip()]
        if not queries:
            return []


        rrf_scores: dict[str, float] = {}
        all_hits: dict[str, dict] = {}
        for q in queries:
            try:
                hits = self.search(q, top_k_per_query, where=where)
            except Exception as e:
                print(f"  [vector_store.search_multi] query 失败 ({type(e).__name__}: "
                      f"{str(e)[:60]}), skip", flush=True)
                continue
            for rank, h in enumerate(hits):
                cid = h.get("chunk_id") or h.get("id")
                if not cid:
                    continue
                rrf_scores[cid] = rrf_scores.get(cid, 0.0) + 1.0 / (rrf_k + rank + 1)
                if cid not in all_hits:
                    all_hits[cid] = h
                all_hits[cid]["rrf_score"] = rrf_scores[cid]
                all_hits[cid]["multi_window_hits"] = all_hits[cid].get("multi_window_hits", 0) + 1

        if not all_hits:
            return []


        merged = sorted(all_hits.values(), key=lambda x: -rrf_scores[x.get("chunk_id") or x.get("id")])


        if rerank_query and rerank_query.strip():

            cand = merged[: max(top_n * RERANK_CANDIDATE_MULTIPLIER, top_n)]
            reranked = self._rerank(rerank_query, cand)
            return reranked[:top_n]
        return merged[:top_n]

    def _search_hybrid(self, query: str, top_k: int, where) -> list[dict]:

        vec_top_k = top_k * RERANK_CANDIDATE_MULTIPLIER
        vec_hits = self._search_vector_only(query, vec_top_k, where)

        bm25_hits: list[dict] = []
        self._bm25_ensure_built()
        if self._bm25 is not None and self._bm25_corpus:
            query_tokens = _tokenize(query)
            scores = self._bm25.get_scores(query_tokens)
            indices = list(range(len(self._bm25_chunks)))
            if where:
                indices = [i for i in indices
                           if all(self._bm25_chunks[i]["metadata"].get(k) == v
                                  for k, v in where.items())]
            pairs = [(scores[i], i) for i in indices]
            pairs.sort(key=lambda x: -x[0])
            pairs = pairs[:vec_top_k]
            for rank, (score, idx) in enumerate(pairs):
                c = self._bm25_chunks[idx]
                bm25_hits.append({
                    "chunk_id": c["chunk_id"],
                    "text": c["text"],
                    "score": float(score),
                    "bm25_score": float(score),
                    "metadata": c["metadata"],
                })

        rrf_scores: dict[str, float] = {}
        all_hits: dict[str, dict] = {}
        for rank, h in enumerate(vec_hits):
            cid = h["chunk_id"]
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
            if cid not in all_hits:
                all_hits[cid] = h.copy()

            all_hits[cid]["vector_score"] = h.get("vector_score", h.get("score", 0.0))
        for rank, h in enumerate(bm25_hits):
            cid = h["chunk_id"]
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
            if cid not in all_hits:
                all_hits[cid] = h.copy()
            all_hits[cid]["bm25_score"] = h.get("score", 0.0)

        for cid, hit in all_hits.items():
            hit["rrf_score"] = rrf_scores[cid]
        ranked = sorted(all_hits.values(), key=lambda x: -x["rrf_score"])

        rerank_top_n = top_k * RERANK_CANDIDATE_MULTIPLIER
        rerank_pool = ranked[:rerank_top_n]
        final_pool = ranked[rerank_top_n:]
        rerank_results = self._rerank(query, rerank_pool)

        final = rerank_results + final_pool

        return final[:top_k]

    def _rerank(self, query: str, candidates: list[dict]) -> list[dict]:
        if not candidates:
            return []
        reranker = _get_reranker()
        if reranker is None or reranker is False:
            for c in candidates:
                c["rerank_score"] = None
            return candidates
        try:
            pairs = [(query, c["text"]) for c in candidates]
            scores = reranker.predict(pairs, show_progress_bar=False)
            for c, s in zip(candidates, scores):
                c["rerank_score"] = float(s)
            return sorted(candidates, key=lambda x: -x["rerank_score"])
        except Exception as e:
            print(f"  [vector_store] rerank 失败 ({type(e).__name__}: {e}), 保留 rrf 顺序",
                  flush=True)
            for c in candidates:
                c["rerank_score"] = None
            return candidates

    def _format_hit(self, results, i: int, vector_score=None) -> dict:
        if i >= len(results["ids"][0]):
            return None
        dist = results["distances"][0][i]
        return {
            "chunk_id": results["ids"][0][i],
            "text": results["documents"][0][i],
            "score": 1 - dist,
            "vector_score": 1 - dist,
            "metadata": results["metadatas"][0][i],
        }

    def search_in_section(self, query: str, section_id: str, top_k: int = 10) -> list[dict]:
        return self.search(query, top_k, where={"section_id": section_id})



    def delete_by_node(self, node_id: str):
        try:
            existing = self._collection.get(where={"node_id": node_id})
            if existing["ids"]:
                self._collection.delete(ids=existing["ids"])
        except Exception:
            pass

    def update_node_status(self, node_id: str, status: str):
        try:
            existing = self._collection.get(where={"node_id": node_id})
            if existing["ids"]:
                new_metas = [{**m, "node_status": status} for m in existing["metadatas"]]
                self._collection.update(ids=existing["ids"], metadatas=new_metas)
        except Exception:
            pass

    def total_chunks(self) -> int:
        return self._collection.count()

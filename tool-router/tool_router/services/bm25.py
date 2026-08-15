"""BM25 检索引擎 — 轻量实现，支持中英文混合分词。

作为混合检索的关键词得分来源，并用于四级分层路由的类别降级兜底。
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict


def tokenize(text: str) -> list[str]:
    """中英文混合分词：英文按空格/标点，中文按字 + 二元组。"""
    text = text.lower().strip()
    en_tokens = re.findall(r"[a-z0-9_]+", text)
    cn_chars = re.findall(r"[\u4e00-\u9fff]", text)
    cn_bigrams = [cn_chars[i] + cn_chars[i + 1] for i in range(len(cn_chars) - 1)]
    return en_tokens + cn_chars + cn_bigrams


class Bm25Index:
    """BM25 索引，支持增量文档添加。"""

    def __init__(self, k1: float = 1.5, b: float = 0.75) -> None:
        self.k1 = k1
        self.b = b
        self._docs: dict[str, list[str]] = {}
        self._tf: dict[str, Counter] = {}
        self._df: dict[str, int] = defaultdict(int)
        self._avg_len: float = 0.0
        self._total_len: int = 0

    def add(self, doc_id: str, text: str) -> None:
        tokens = tokenize(text)
        self._docs[doc_id] = tokens
        tf = Counter(tokens)
        self._tf[doc_id] = tf
        self._total_len += len(tokens)
        self._avg_len = self._total_len / max(1, len(self._docs))
        for term in tf:
            self._df[term] += 1

    def remove(self, doc_id: str) -> None:
        if doc_id not in self._docs:
            return
        tf = self._tf.pop(doc_id)
        self._total_len -= len(self._docs.pop(doc_id))
        for term in tf:
            self._df[term] -= 1
            if self._df[term] <= 0:
                del self._df[term]
        self._avg_len = self._total_len / max(1, len(self._docs))

    def search(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        q_tokens = tokenize(query)
        if not q_tokens:
            return []
        n = len(self._docs)
        scores: dict[str, float] = defaultdict(float)
        for term in q_tokens:
            df = self._df.get(term, 0)
            if df == 0:
                continue
            idf = math.log((n - df + 0.5) / (df + 0.5) + 1)
            for doc_id, tf in self._tf.items():
                f = tf.get(term, 0)
                if f == 0:
                    continue
                dl = len(self._docs[doc_id])
                denom = f + self.k1 * (1 - self.b + self.b * dl / max(1, self._avg_len))
                scores[doc_id] += idf * (f * (self.k1 + 1)) / denom
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return ranked[:top_k]

    @property
    def size(self) -> int:
        return len(self._docs)

    def rebuild(self, docs: list[tuple[str, str]]) -> None:
        """全量重建索引。"""
        self._docs.clear()
        self._tf.clear()
        self._df.clear()
        self._total_len = 0
        for doc_id, text in docs:
            self.add(doc_id, text)
# 神经检索 sidecar（N1 embedding + N2 rerank + N3 意图分类）
# 构建期预热模型层：权重进入镜像，容器首启无需下载（约 2 分钟）。
# 模型版本锁：构建与运行用同一个 AGNEURAL_MODEL_REVISION（建议 commit hash），
# 防止上游模型更新导致 TS 侧磁盘缓存向量与模型静默失配。
#
# 构建：docker build -t neural-retrieval-sidecar --build-arg AGNEURAL_MODEL_REVISION=<hash> .
# 运行：docker run -d -p 8790:8790 neural-retrieval-sidecar

FROM python:3.11-slim

WORKDIR /app

ARG AGNEURAL_EMBED_MODEL=BAAI/bge-small-zh-v1.5
ARG AGNEURAL_RERANK_MODEL=BAAI/bge-reranker-base
ARG AGNEURAL_MODEL_REVISION=

ENV AGNEURAL_EMBED_MODEL=${AGNEURAL_EMBED_MODEL} \
    AGNEURAL_RERANK_MODEL=${AGNEURAL_RERANK_MODEL} \
    AGNEURAL_MODEL_REVISION=${AGNEURAL_MODEL_REVISION} \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt ./
RUN pip install -r requirements.txt

# 模型预热层（revision 锁定在构建期固定；权重变更 = 层缓存失效 = 重新下载）
RUN python -c "\
from sentence_transformers import SentenceTransformer, CrossEncoder; \
SentenceTransformer('$AGNEURAL_EMBED_MODEL', revision='$AGNEURAL_MODEL_REVISION' or None); \
CrossEncoder('$AGNEURAL_RERANK_MODEL', max_length=512, revision='$AGNEURAL_MODEL_REVISION' or None); \
print('models warmed')"

COPY main.py ./

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; \
d=__import__('json').load(urllib.request.urlopen('http://127.0.0.1:8790/health', timeout=4)); \
sys.exit(0 if d.get('ok') else 1)"

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8790"]

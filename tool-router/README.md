# Adaptive Hierarchical Tool Intelligence System

This directory contains the standalone `tool-router/` subsystem described in `.trae/specs/build-adaptive-tool-intelligence-system/spec.md`.

Implemented foundation:

- standalone FastAPI service
- fixed execution pipeline:
  1. Intent Router
  2. Hierarchical Router
  3. Hybrid Retrieval
  4. Adaptive Top-P
  5. Knowledge-Graph Expansion
  6. Tool Reranking
  7. Dynamic Lazy-Loading
  8. Resource Execute
  9. Feedback Learning
- three-level resource metadata model
- nine REST APIs required by the spec
- independent infrastructure compose file for Qdrant, PostgreSQL, Redis, Neo4j, RabbitMQ, Prometheus
- Celery worker skeleton for async feedback persistence

Current implementation choice:

- external backends are wired as config-driven adapters, with an in-memory fallback so the service can boot before infrastructure is attached
- the routing path follows the spec hierarchy strictly: `DomainGroup -> Domain -> Capability -> Resource`
- online feedback updates history, failure penalty, top-p overrides, and circuit-breaker status

Quick start:

```bash
cd tool-router
python -m venv .venv
.venv\Scripts\activate
pip install -e .
uvicorn tool_router.main:app --reload --port 8787
```

Infrastructure:

```bash
docker compose -f docker-compose.infra.yml up -d
```

from __future__ import annotations

import os

from pydantic import BaseModel, Field


class Settings(BaseModel):
    env: str = "dev"
    host: str = "0.0.0.0"
    port: int = 8787
    default_tenant: str = "default"

    redis_url: str | None = None
    qdrant_url: str | None = None
    postgres_dsn: str | None = None
    neo4j_uri: str | None = None
    neo4j_username: str | None = None
    neo4j_password: str | None = None
    rabbitmq_url: str | None = None

    prometheus_enabled: bool = True
    otel_enabled: bool = False

    route_cache_ttl_seconds: int = 30
    schema_cache_size: int = 256
    rate_limited_failure_threshold: int = 3
    default_base_score: float = Field(default=0.5, ge=0.0, le=1.0)


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_settings() -> Settings:
    return Settings(
        env=os.getenv("TOOL_ROUTER_ENV", "dev"),
        host=os.getenv("TOOL_ROUTER_HOST", "0.0.0.0"),
        port=int(os.getenv("TOOL_ROUTER_PORT", "8787")),
        default_tenant=os.getenv("TOOL_ROUTER_DEFAULT_TENANT", "default"),
        redis_url=os.getenv("TOOL_ROUTER_REDIS_URL"),
        qdrant_url=os.getenv("TOOL_ROUTER_QDRANT_URL"),
        postgres_dsn=os.getenv("TOOL_ROUTER_POSTGRES_DSN"),
        neo4j_uri=os.getenv("TOOL_ROUTER_NEO4J_URI"),
        neo4j_username=os.getenv("TOOL_ROUTER_NEO4J_USERNAME"),
        neo4j_password=os.getenv("TOOL_ROUTER_NEO4J_PASSWORD"),
        rabbitmq_url=os.getenv("TOOL_ROUTER_RABBITMQ_URL"),
        prometheus_enabled=_bool_env("TOOL_ROUTER_PROMETHEUS_ENABLED", True),
        otel_enabled=_bool_env("TOOL_ROUTER_OTEL_ENABLED", False),
        route_cache_ttl_seconds=int(os.getenv("TOOL_ROUTER_ROUTE_CACHE_TTL_SECONDS", "30")),
        schema_cache_size=int(os.getenv("TOOL_ROUTER_SCHEMA_CACHE_SIZE", "256")),
        rate_limited_failure_threshold=int(os.getenv("TOOL_ROUTER_RATE_LIMITED_FAILURE_THRESHOLD", "3")),
        default_base_score=float(os.getenv("TOOL_ROUTER_DEFAULT_BASE_SCORE", "0.5")),
    )


settings = load_settings()

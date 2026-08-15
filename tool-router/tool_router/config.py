from __future__ import annotations

import os

from pydantic import BaseModel, Field


class Settings(BaseModel):
    env: str = "dev"
    host: str = "0.0.0.0"
    port: int = 8787
    default_tenant: str = "default"

    # 可选外部后端（未配置时服务以纯内存模式运行，接口照常可用）
    redis_url: str | None = None
    qdrant_url: str | None = None
    postgres_dsn: str | None = None
    neo4j_uri: str | None = None
    neo4j_username: str | None = None
    neo4j_password: str | None = None
    rabbitmq_url: str | None = None

    route_cache_ttl_seconds: int = 30
    schema_cache_size: int = 256
    rate_limited_failure_threshold: int = 3
    default_base_score: float = Field(default=0.5, ge=0.0, le=1.0)

    # ===== 混合检索动态权重 =====
    # 短关键词指令
    weight_short_bm25: float = 0.40
    weight_short_embed: float = 0.25
    # 长文本模糊需求
    weight_long_embed: float = 0.60
    weight_long_bm25: float = 0.20
    # 可调公共项
    weight_history: float = 0.20
    weight_latency: float = 0.10
    weight_failure: float = 0.30
    # 短 / 长 query 分界（字符数）
    short_query_threshold: int = 12

    # ===== Adaptive Top-P =====
    top_p_high_conf: float = 0.70    # confidence > 0.85
    top_p_mid_conf: float = 0.90     # 0.6 < confidence <= 0.85
    top_p_low_conf: float = 0.95     # confidence <= 0.6
    min_candidate: int = 3
    max_candidate: int = 25

    # ===== 熔断 =====
    circuit_breaker_threshold: int = 5       # 连续失败次数
    circuit_breaker_cooldown_ms: int = 60_000

    # ===== 滑动窗口 =====
    history_window_size: int = 50


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
        route_cache_ttl_seconds=int(os.getenv("TOOL_ROUTER_ROUTE_CACHE_TTL_SECONDS", "30")),
        schema_cache_size=int(os.getenv("TOOL_ROUTER_SCHEMA_CACHE_SIZE", "256")),
        rate_limited_failure_threshold=int(os.getenv("TOOL_ROUTER_RATE_LIMITED_FAILURE_THRESHOLD", "3")),
        default_base_score=float(os.getenv("TOOL_ROUTER_DEFAULT_BASE_SCORE", "0.5")),
    )


settings = load_settings()

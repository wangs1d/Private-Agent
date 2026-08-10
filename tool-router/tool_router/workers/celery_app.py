from __future__ import annotations

from celery import Celery

from tool_router.config import settings


celery_app = Celery(
    "tool_router",
    broker=settings.rabbitmq_url or "memory://",
    backend="rpc://",
)

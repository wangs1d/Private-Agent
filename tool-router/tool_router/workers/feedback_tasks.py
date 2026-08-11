from __future__ import annotations

from tool_router.workers.celery_app import celery_app


@celery_app.task(name="tool_router.feedback.persist")
def persist_feedback(payload: dict) -> dict:
    return {"accepted": True, "payload_size": len(payload)}

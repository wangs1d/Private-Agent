from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from tool_router.api import create_router
from tool_router.container import build_container
from tool_router.users_api import create_users_router

container = build_container()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.container = container
    yield


app = FastAPI(
    title="Adaptive Tool Router",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(create_router(container))
app.include_router(create_users_router(container))

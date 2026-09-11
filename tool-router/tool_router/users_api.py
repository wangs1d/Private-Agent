from __future__ import annotations

from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from tool_router.container import Container
from tool_router.models import (
    ApiEnvelope,
    AuthSessionPayload,
    UserLoginRequest,
    UserPublic,
    UserRegisterRequest,
    UserUpdateRequest,
)
from tool_router.services.user_store import (
    InvalidCredentialsError,
    InvalidTokenError,
    PasswordMismatchError,
    UserAlreadyExistsError,
    UserDisabledError,
    UserNotFoundError,
)

_bearer = HTTPBearer(auto_error=False)


def create_users_router(container: Container) -> APIRouter:
    router = APIRouter(prefix="/api/users", tags=["users"])

    def wrap(tenant_id: str, data, started_at: float) -> ApiEnvelope:
        return ApiEnvelope(
            ok=True,
            tenant_id=tenant_id,
            environment=container.settings.env,
            elapsed_ms=round((perf_counter() - started_at) * 1000, 3),
            data=data,
        )

    def current_user(
        credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    ) -> UserPublic:
        if credentials is None:
            raise HTTPException(status_code=401, detail="missing_bearer_token")
        try:
            claims = container.users.verify_token(credentials.credentials)
            record = container.users.get_user(claims.sub)
        except InvalidTokenError as exc:
            raise HTTPException(status_code=401, detail=f"invalid_token: {exc}") from exc
        except UserNotFoundError as exc:
            raise HTTPException(status_code=401, detail="user_not_found") from exc
        if record.status.value != "active":
            raise HTTPException(status_code=403, detail="user_disabled")
        return record.public()

    def require_admin(user: UserPublic = Depends(current_user)) -> UserPublic:
        if user.role.value != "admin":
            raise HTTPException(status_code=403, detail="admin_required")
        return user

    @router.post("/register", status_code=201)
    async def register_user(payload: UserRegisterRequest) -> ApiEnvelope:
        """接收前端注册表单：校验 → 落库（含 JSON 落盘）→ 返回用户信息 + 访问令牌。"""
        started = perf_counter()
        try:
            record = container.users.register(payload)
        except UserAlreadyExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        container.metrics.inc("users.register")
        session = AuthSessionPayload(user=record.public(), token=container.users.issue_token(record))
        return wrap(record.tenant_id, session.model_dump(mode="json"), started)

    @router.post("/login")
    async def login_user(payload: UserLoginRequest) -> ApiEnvelope:
        started = perf_counter()
        try:
            record = container.users.authenticate(payload.username, payload.password)
        except InvalidCredentialsError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except UserDisabledError as exc:
            raise HTTPException(status_code=403, detail="user_disabled") from exc
        container.metrics.inc("users.login")
        session = AuthSessionPayload(user=record.public(), token=container.users.issue_token(record))
        return wrap(record.tenant_id, session.model_dump(mode="json"), started)

    @router.get("/me")
    async def get_me(user: UserPublic = Depends(current_user)) -> ApiEnvelope:
        started = perf_counter()
        return wrap(user.tenant_id, user.model_dump(mode="json"), started)

    @router.put("/me")
    async def update_me(payload: UserUpdateRequest, user: UserPublic = Depends(current_user)) -> ApiEnvelope:
        started = perf_counter()
        updates = payload.model_dump(exclude_unset=True, exclude={"current_password", "new_password"})
        try:
            record = container.users.update_profile(
                user.user_id,
                updates,
                payload.current_password,
                payload.new_password,
            )
        except PasswordMismatchError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except UserAlreadyExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        container.metrics.inc("users.update")
        return wrap(record.tenant_id, record.public().model_dump(mode="json"), started)

    @router.get("")
    async def list_users(
        admin: UserPublic = Depends(require_admin),
    ) -> ApiEnvelope:
        """管理员拉取全部已注册用户（即前端提交的注册信息）。"""
        started = perf_counter()
        users = container.users.list_users()
        container.metrics.inc("users.list")
        return wrap(
            admin.tenant_id,
            {"total": len(users), "users": [item.model_dump(mode="json") for item in users]},
            started,
        )

    @router.get("/{user_id}")
    async def get_user(user_id: str, user: UserPublic = Depends(current_user)) -> ApiEnvelope:
        started = perf_counter()
        if user.role.value != "admin" and user.user_id != user_id:
            raise HTTPException(status_code=403, detail="admin_required")
        try:
            record = container.users.get_user(user_id)
        except UserNotFoundError as exc:
            raise HTTPException(status_code=404, detail="user_not_found") from exc
        return wrap(record.tenant_id, record.public().model_dump(mode="json"), started)

    return router

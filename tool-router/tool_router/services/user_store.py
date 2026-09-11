from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path
from typing import Any

from tool_router.config import Settings
from tool_router.models import (
    TokenPayload,
    TokenResponse,
    UserPublic,
    UserRecord,
    UserRegisterRequest,
    UserRole,
    UserStatus,
    utcnow,
)

# OWASP 建议 SHA-256 的 PBKDF2 迭代次数下限为 60 万，开发场景取 Django 默认值
PBKDF2_ITERATIONS = 260_000
JWT_ALGORITHM = "HS256"


class UserAlreadyExistsError(Exception):
    pass


class InvalidCredentialsError(Exception):
    pass


class UserDisabledError(Exception):
    pass


class UserNotFoundError(Exception):
    pass


class InvalidTokenError(Exception):
    pass


class PasswordMismatchError(Exception):
    pass


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt_b64, digest_b64 = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64.b64decode(salt_b64),
            int(iterations),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


class UserStore:
    """用户账户存储 + 认证。默认纯内存，配置 users_store_path 时 JSON 落盘。"""

    def __init__(self, cfg: Settings):
        self.cfg = cfg
        self._users: dict[str, UserRecord] = {}
        self._usernames: dict[str, str] = {}
        self._emails: dict[str, str] = {}
        self._path = Path(cfg.users_store_path) if cfg.users_store_path else None
        self._load()

    # ===== 注册 / 查询 =====

    def register(self, payload: UserRegisterRequest, tenant_id: str | None = None) -> UserRecord:
        username_key = payload.username.lower()
        if username_key in self._usernames:
            raise UserAlreadyExistsError(f"username '{payload.username}' already exists")
        if payload.email and payload.email.lower() in self._emails:
            raise UserAlreadyExistsError(f"email '{payload.email}' already exists")

        now = utcnow()
        record = UserRecord(
            user_id=f"usr_{secrets.token_hex(8)}",
            username=payload.username,
            email=payload.email,
            nickname=payload.nickname or payload.username,
            phone=payload.phone,
            password_hash=hash_password(payload.password),
            # 首个注册用户自动成为管理员，便于运维接口的初始接入
            role=UserRole.admin if not self._users else UserRole.user,
            status=UserStatus.active,
            tenant_id=tenant_id or self.cfg.default_tenant,
            created_at=now,
            updated_at=now,
        )
        self._index(record)
        self._save()
        return record

    def get_user(self, user_id: str) -> UserRecord:
        record = self._users.get(user_id)
        if record is None:
            raise UserNotFoundError(user_id)
        return record

    def list_users(self, tenant_id: str | None = None) -> list[UserPublic]:
        records = sorted(self._users.values(), key=lambda item: item.created_at)
        if tenant_id:
            records = [item for item in records if item.tenant_id == tenant_id]
        return [item.public() for item in records]

    # ===== 认证 =====

    def authenticate(self, username: str, password: str) -> UserRecord:
        record = self._users.get(self._usernames.get(username.lower(), ""))
        if record is None or not verify_password(password, record.password_hash):
            raise InvalidCredentialsError("invalid username or password")
        if record.status != UserStatus.active:
            raise UserDisabledError(record.username)
        record.last_login_at = utcnow()
        self._save()
        return record

    def issue_token(self, record: UserRecord) -> TokenResponse:
        now = int(time.time())
        expires_in = self.cfg.access_token_expire_minutes * 60
        claims = TokenPayload(
            sub=record.user_id,
            username=record.username,
            role=record.role,
            iat=now,
            exp=now + expires_in,
        )
        return TokenResponse(
            access_token=self._sign_jwt(claims.model_dump(mode="json")),
            expires_in=expires_in,
        )

    def verify_token(self, token: str) -> TokenPayload:
        try:
            header_b64, payload_b64, signature_b64 = token.split(".")
            header = json.loads(_b64url_decode(header_b64))
            if header.get("alg") != JWT_ALGORITHM:
                raise InvalidTokenError("unsupported algorithm")
            expected = self._signature(f"{header_b64}.{payload_b64}")
            if not hmac.compare_digest(expected, _b64url_decode(signature_b64)):
                raise InvalidTokenError("bad signature")
            claims = TokenPayload.model_validate(json.loads(_b64url_decode(payload_b64)))
        except (ValueError, InvalidTokenError):
            raise
        except Exception as exc:  # 结构损坏 / JSON 解码失败
            raise InvalidTokenError("malformed token") from exc
        if claims.exp <= int(time.time()):
            raise InvalidTokenError("token expired")
        return claims

    def update_profile(
        self,
        user_id: str,
        updates: dict[str, Any],
        current_password: str | None = None,
        new_password: str | None = None,
    ) -> UserRecord:
        record = self.get_user(user_id)

        email = updates.get("email")
        if email and email.lower() != str(record.email).lower() and email.lower() in self._emails:
            raise UserAlreadyExistsError(f"email '{email}' already exists")

        if new_password is not None:
            if current_password is None or not verify_password(current_password, record.password_hash):
                raise PasswordMismatchError("current_password is required and must match")
            record.password_hash = hash_password(new_password)

        for field in ("nickname", "email", "phone"):
            if field in updates:
                setattr(record, field, updates[field])

        record.updated_at = utcnow()
        self._reindex_email(record)
        self._save()
        return record

    # ===== 内部实现 =====

    def _index(self, record: UserRecord) -> None:
        self._users[record.user_id] = record
        self._usernames[record.username.lower()] = record.user_id
        if record.email:
            self._emails[record.email.lower()] = record.user_id

    def _reindex_email(self, record: UserRecord) -> None:
        self._emails = {
            email: uid for email, uid in self._emails.items() if uid != record.user_id
        }
        if record.email:
            self._emails[record.email.lower()] = record.user_id

    def _signature(self, signing_input: str) -> bytes:
        return hmac.new(
            self.cfg.secret_key.encode("utf-8"),
            signing_input.encode("ascii"),
            hashlib.sha256,
        ).digest()

    def _sign_jwt(self, claims: dict[str, Any]) -> str:
        header = {"alg": JWT_ALGORITHM, "typ": "JWT"}
        header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        payload_b64 = _b64url_encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
        signature = _b64url_encode(self._signature(f"{header_b64}.{payload_b64}"))
        return f"{header_b64}.{payload_b64}.{signature}"

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for item in raw if isinstance(raw, list) else raw.get("users", []):
            try:
                self._index(UserRecord.model_validate(item))
            except Exception:
                continue

    def _save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = [item.model_dump(mode="json") for item in self._users.values()]
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self._path)

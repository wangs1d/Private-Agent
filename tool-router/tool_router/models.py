from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Environment(str, Enum):
    dev = "dev"
    staging = "staging"
    prod = "prod"


class ResourceType(str, Enum):
    tool = "tool"
    skill = "skill"
    mcp_server = "mcp_server"


class ResourceStatus(str, Enum):
    online = "online"
    offline = "offline"
    maintenance = "maintenance"
    rate_limited = "rate_limited"


class AuthLevel(str, Enum):
    guest = "guest"
    default = "default"
    admin = "admin"


class QueryConstraints(BaseModel):
    max_latency_ms: int = 200
    read_only: bool = False
    file_type: str | None = None
    auth_level: AuthLevel = AuthLevel.default


class ParsedIntent(BaseModel):
    intent: str
    domain_candidates: list[str] = Field(default_factory=list)
    primary_capability: str = "misc.general"
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    query_constraints: QueryConstraints = Field(default_factory=QueryConstraints)
    param_extract: dict[str, Any] = Field(default_factory=dict)
    is_compound_task: bool = False
    sub_intents: list["ParsedIntent"] = Field(default_factory=list)


class Level1IndexMeta(BaseModel):
    resource_id: str
    tenant_id: str = "default"
    resource_type: ResourceType
    name: str
    description: str
    domain: str
    capability: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    version: str = "1.0.0"
    environment: Environment = Environment.dev
    status: ResourceStatus = ResourceStatus.online
    base_score: float = Field(default=0.5, ge=0.0, le=1.0)
    embedding: list[float] = Field(default_factory=list)
    latency_ms: int = 100
    created_at: datetime = Field(default_factory=utcnow)


class Level2CapabilityMeta(BaseModel):
    input_type: str = "json"
    output_type: str = "json"
    use_cases: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    preconditions: list[str] = Field(default_factory=list)
    dependencies: list[str] = Field(default_factory=list)


class ToolExecutionSchema(BaseModel):
    parameters: dict[str, Any] = Field(default_factory=dict)
    required: list[str] = Field(default_factory=list)
    timeout_ms: int = 15000


class SkillExecutionSchema(BaseModel):
    workflow: list[str] = Field(default_factory=list)
    child_resources: list[str] = Field(default_factory=list)
    retry_policy: dict[str, Any] = Field(default_factory=dict)
    fallback_resources: list[str] = Field(default_factory=list)


class McpExecutionSchema(BaseModel):
    transport: str = "http"
    endpoint: str | None = None
    rpc_methods: list[str] = Field(default_factory=list)
    auth_config: dict[str, Any] = Field(default_factory=dict)
    connection_pool: dict[str, Any] = Field(default_factory=dict)
    heartbeat_interval_seconds: int = 30


class Level3ExecutionSchema(BaseModel):
    tool: ToolExecutionSchema | None = None
    skill: SkillExecutionSchema | None = None
    mcp_server: McpExecutionSchema | None = None


class ResourceRecord(BaseModel):
    level1: Level1IndexMeta
    level2: Level2CapabilityMeta = Field(default_factory=Level2CapabilityMeta)
    level3: Level3ExecutionSchema = Field(default_factory=Level3ExecutionSchema)
    auth_level: AuthLevel = AuthLevel.default
    history_success_score: float = Field(default=0.5, ge=0.0, le=1.0)
    failure_penalty: float = Field(default=0.0, ge=0.0, le=1.0)
    latency_score: float = Field(default=0.5, ge=0.0, le=1.0)
    consecutive_failures: int = 0


class ResourceRegisterRequest(BaseModel):
    resource: ResourceRecord


class CatalogInitRequest(BaseModel):
    """批量初始化目录：与 stdio worker 的 init_catalog 载荷对齐，一次注册全部资源与图边。"""

    signature: str | None = None
    resources: list[ResourceRecord] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


class IntentDecomposeRequest(BaseModel):
    raw_user_query: str
    agent_context_hash: str


class SearchRequest(BaseModel):
    raw_user_query: str
    agent_context_hash: str
    tenant_id: str = "default"
    environment: Environment = Environment.dev
    limit: int = 10


class SearchCandidate(BaseModel):
    resource_id: str
    name: str
    resource_type: ResourceType
    domain_group: str
    domain: str
    capabilities: list[str]
    score: float
    stage_scores: dict[str, float] = Field(default_factory=dict)


class SearchResponsePayload(BaseModel):
    parsed_intent: ParsedIntent
    domain_groups: list[str]
    domains: list[str]
    capabilities: list[str]
    candidates: list[SearchCandidate]
    search_path: list[str]


class LoadRequest(BaseModel):
    tenant_id: str = "default"
    resource_id: str


class ExecuteRequest(BaseModel):
    tenant_id: str = "default"
    resource_id: str
    params: dict[str, Any] = Field(default_factory=dict)
    timeout_ms: int = 15000
    dry_run: bool = False
    raw_query: str | None = None
    agent_context_hash: str | None = None


class ExecuteResponsePayload(BaseModel):
    resource_id: str
    status: str
    mode: str
    result: dict[str, Any]
    fallback_resource_id: str | None = None


class FeedbackEntry(BaseModel):
    raw_query: str
    parsed_intent: ParsedIntent
    resource_id: str
    resource_type: ResourceType
    success: bool
    error_code: str | None = None
    latency_ms: int = 0
    result_quality_score: float = Field(default=0.5, ge=0.0, le=1.0)
    user_feedback: str | None = None
    context_hash: str
    call_timestamp: datetime


class FeedbackBatchRequest(BaseModel):
    items: list[FeedbackEntry]


class GraphRelationType(str, Enum):
    similar_to = "similar_to"
    depends_on = "depends_on"
    requires = "requires"
    alternative_to = "alternative_to"
    combine_with = "combine_with"
    supersede = "supersede"
    conflict_with = "conflict_with"
    child_of = "child_of"


class GraphEdge(BaseModel):
    source_id: str
    target_id: str
    relation: GraphRelationType
    weight: float = 1.0


class GraphQueryRequest(BaseModel):
    resource_id: str
    relation_types: list[GraphRelationType] = Field(default_factory=list)
    depth: int = 1


class ResourceHealthPayload(BaseModel):
    backends: dict[str, str]
    resources: list[dict[str, Any]]


class ApiEnvelope(BaseModel):
    ok: bool = True
    tenant_id: str
    environment: str
    elapsed_ms: float
    data: Any


# ===== 用户管理 =====

USERNAME_PATTERN = r"^[A-Za-z0-9_.-]+$"
EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
PHONE_PATTERN = r"^\+?[0-9][0-9-]{4,19}$"


class UserRole(str, Enum):
    admin = "admin"
    user = "user"


class UserStatus(str, Enum):
    active = "active"
    disabled = "disabled"


class UserRecord(BaseModel):
    """存储层完整记录（含 password_hash，禁止直接对外返回）。"""

    user_id: str
    username: str
    email: str | None = None
    nickname: str | None = None
    phone: str | None = None
    password_hash: str
    role: UserRole = UserRole.user
    status: UserStatus = UserStatus.active
    tenant_id: str = "default"
    created_at: datetime
    updated_at: datetime
    last_login_at: datetime | None = None

    def public(self) -> UserPublic:
        return UserPublic(
            user_id=self.user_id,
            username=self.username,
            email=self.email,
            nickname=self.nickname,
            phone=self.phone,
            role=self.role,
            status=self.status,
            tenant_id=self.tenant_id,
            created_at=self.created_at,
            updated_at=self.updated_at,
            last_login_at=self.last_login_at,
        )


class UserPublic(BaseModel):
    """对外返回的用户信息（不含凭据字段）。"""

    user_id: str
    username: str
    email: str | None = None
    nickname: str | None = None
    phone: str | None = None
    role: UserRole
    status: UserStatus
    tenant_id: str
    created_at: datetime
    updated_at: datetime
    last_login_at: datetime | None = None


class UserRegisterRequest(BaseModel):
    """前端注册表单提交的字段（除必填外均可选，按需提交）。"""

    username: str = Field(min_length=3, max_length=32, pattern=USERNAME_PATTERN)
    password: str = Field(min_length=8, max_length=128)
    email: str | None = Field(default=None, max_length=254, pattern=EMAIL_PATTERN)
    nickname: str | None = Field(default=None, min_length=1, max_length=64)
    phone: str | None = Field(default=None, pattern=PHONE_PATTERN)


class UserLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class UserUpdateRequest(BaseModel):
    """PATCH 语义：仅更新显式传入的字段；email/phone 传 null 表示清空。"""

    nickname: str | None = Field(default=None, min_length=1, max_length=64)
    email: str | None = Field(default=None, max_length=254, pattern=EMAIL_PATTERN)
    phone: str | None = Field(default=None, pattern=PHONE_PATTERN)
    current_password: str | None = Field(default=None, max_length=128)
    new_password: str | None = Field(default=None, min_length=8, max_length=128)


class TokenPayload(BaseModel):
    """JWT 解码后的声明。"""

    sub: str
    username: str
    role: UserRole
    iat: int
    exp: int


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int

class AuthSessionPayload(BaseModel):
    user: UserPublic
    token: TokenResponse

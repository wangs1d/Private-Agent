"""
desktop_visual.run_shell 的安全策略：白名单命令 + 黑名单短路 + 环境变量脱敏。

设计参考：
  - Anthropic Claude Code Auto Mode (2026) - classifyAllShell
  - OpenAI Codex Computer Use - allowlist commands + 用户确认

所有判断走纯函数，stdio_worker 调进来拿到 ShellDecision，按决定 pass/refuse/modify。
"""
from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field
from typing import Literal

# --------------------------------------------------------------------------- #
# 默认白名单（按 shell 分类，每条是「命令的第一个 token」大小写不敏感匹配）
# --------------------------------------------------------------------------- #

# 只读 / 信息查询类 —— 默认放行
DEFAULT_ALLOWLIST: dict[str, set[str]] = {
    "cmd": {
        "dir", "cd", "echo", "type", "more", "findstr", "where", "whoami",
        "systeminfo", "ver", "set", "path", "hostname", "date", "time",
        "tasklist", "sc", "query",  # query session/query user
        "ipconfig", "ping", "tracert", "nslookup", "netstat", "arp", "route",
        "wmic",  # 只允许 wmic 读，不允许写
    },
    "powershell": {
        "Get-ChildItem", "Get-Item", "Get-Content", "Get-Process", "Get-Service",
        "Get-Location", "Get-Date", "Get-Host", "Get-ComputerInfo", "Get-CimInstance",
        "Get-WmiObject", "Get-ItemProperty", "Get-ItemPropertyValue",
        "Get-Variable", "Get-Command", "Get-Help", "Get-Member", "Get-Alias",
        "Get-History", "Get-PSDrive", "Get-ChildItem", "Get-Process",
        "Get-NetIPAddress", "Get-NetAdapter", "Get-NetRoute", "Get-DnsClient",
        "Select-Object", "Where-Object", "Sort-Object", "Format-Table",
        "Format-List", "Format-Wide", "Out-Host", "Out-String", "Write-Output",
        "Write-Host", "Read-Host", "Measure-Object", "Group-Object",
        "Test-Path", "Test-Connection", "Resolve-Path", "ConvertTo-Json",
        "Test-NetConnection",
        "echo", "pwd", "ls", "cat", "where", "whoami", "date", "hostname",
    },
    "bash": {
        "ls", "cat", "head", "tail", "less", "more", "echo", "pwd", "whoami",
        "hostname", "date", "uname", "env", "printenv", "id", "groups",
        "ps", "top", "df", "du", "free", "uptime", "which", "whereis",
        "find", "grep", "awk", "sed", "wc", "sort", "uniq", "cut", "tr",
        "stat", "file", "tree", "xargs", "tee", "ping", "traceroute",
        "nslookup", "dig", "ifconfig", "ip", "netstat", "ss", "curl", "wget",
        "git",  # 状态查询类会被黑名单短路，只读还是允许
    },
}

# 危险命令（黑名单短路）—— 不管 allowDestructive 与否都拒
DEFAULT_DENYLIST: set[str] = {
    # 文件/目录破坏
    "del", "erase", "rd", "rmdir", "rm", "rm-rf", "rm-r", "mv", "move",
    "Remove-Item", "Remove-ItemProperty", "Remove-Variable", "Remove-PSDrive",
    "Clear-Content", "Clear-Item", "Clear-ItemProperty", "ri", "rm",
    "Set-Content", "Add-Content",  # 写文件类默认禁
    "Out-File", "Set-Clipboard",
    # 系统/服务
    "Stop-Service", "Start-Service", "Restart-Service", "Set-Service",
    "Stop-Process", "Kill", "taskkill", "taskkill.exe",
    "Shutdown", "Restart-Computer", "Stop-Computer", "Logoff", "logoff.exe",
    "Format-Volume", "Format-", "diskpart", "bcdedit", "bootrec",
    # 注册表/网络账户
    "reg", "reg.exe", "regedit", "regedit.exe",
    "net", "netsh", "nbtstat",  # net 包含 user/localgroup 等；读 netstat 已放白名单
    "New-LocalUser", "Set-LocalUser", "Remove-LocalUser",
    "Set-NetFirewallRule", "Remove-NetFirewallRule", "New-NetFirewallRule",
    # 远程/下载执行
    "Invoke-Expression", "iex", "Invoke-WebRequest", "iwr", "curl-exec",
    "wget-exec", "Start-BitsTransfer", "bitsadmin",
    # 权限提升
    "runas", "Start-Process", "Start-ProcessWithPatientCaller",
    # 计划任务
    "schtasks", "Register-ScheduledTask", "Unregister-ScheduledTask",
    # 凭据/机密
    "Get-Credential", "ConvertTo-SecureString",
}

# 高危模式（regex 命中整条命令就拒）—— 防止用 `cmd /c` 嵌套 / 管道逃逸
DEFAULT_DENY_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bInvoke-Expression\b", re.IGNORECASE),
    re.compile(r"\biex\b\s*[\(\"']", re.IGNORECASE),
    re.compile(r"\bFromBase64String\b", re.IGNORECASE),
    re.compile(r"\bDownloadString\b", re.IGNORECASE),
    re.compile(r"\bDownloadFile\b", re.IGNORECASE),
    re.compile(r"Net\.WebClient", re.IGNORECASE),
    re.compile(r"\bStart-BitsTransfer\b", re.IGNORECASE),
    re.compile(r"\|\s*Out-File\b", re.IGNORECASE),
    re.compile(r"\|\s*Set-Content\b", re.IGNORECASE),
    re.compile(r">\s*\$\{?env:", re.IGNORECASE),
    re.compile(r"\$\(curl\b", re.IGNORECASE),
    re.compile(r"`[^\`]{0,200}`.*\brm\b", re.IGNORECASE),  # PS backtick chain to rm
    re.compile(r";\s*(Remove-Item|Stop-Process|Remove-ItemProperty)\b", re.IGNORECASE),
    re.compile(r"&&\s*(Remove-Item|del|rm|Stop-Process|Remove-ItemProperty)\b", re.IGNORECASE),
    re.compile(r"\|\s*(Remove-Item|rm|del)\b", re.IGNORECASE),
    re.compile(r"cmd\s*/c\s+(del|rm|rd|format)", re.IGNORECASE),
    re.compile(r"powershell\s+-(e|enc|EncodedCommand)\b", re.IGNORECASE),
    re.compile(r"\bsudo\b", re.IGNORECASE),
    re.compile(r"\bchmod\s+[0-7]{3,4}\b", re.IGNORECASE),  # 改权限默认禁
    re.compile(r"\bchown\b", re.IGNORECASE),
    re.compile(r"\bdd\s+if=", re.IGNORECASE),
    re.compile(r"\bmkfs(\.[a-z0-9]+)?\b", re.IGNORECASE),
    re.compile(r"\bkill\s+-9\b", re.IGNORECASE),
    re.compile(r"\bpkill\b", re.IGNORECASE),
]

# 脱敏正则 —— 在传给 subprocess 之前，把命令行里出现的 *_KEY / *_SECRET 替换
SENSITIVE_ENV_PATTERN = re.compile(r"^[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|APIKEY)[A-Z_]*$", re.IGNORECASE)


@dataclass
class ShellDecision:
    allowed: bool
    reason: str = ""
    sanitized_command: str = ""
    sanitized_env: dict[str, str] = field(default_factory=dict)
    detected_shell: Literal["cmd", "powershell", "bash"] = "cmd"
    first_token: str = ""


def _detect_shell(explicit: str | None) -> Literal["cmd", "powershell", "bash"]:
    if explicit in ("cmd", "powershell", "bash"):
        return explicit  # type: ignore[return-value]
    if os.name == "nt":
        return "powershell"
    return "bash"


def _first_token(command: str) -> str:
    if not command or not command.strip():
        return ""
    # 去前导空白；去路径前缀
    first = command.lstrip().split(maxsplit=1)[0] if command.strip() else ""
    # 处理 ./foo / /usr/bin/foo / foo.exe / foo.cmd
    base = os.path.basename(first)
    for ext in (".exe", ".cmd", ".bat", ".ps1", ".sh"):
        if base.lower().endswith(ext):
            base = base[: -len(ext)]
            break
    return base


def sanitize_env(env: dict[str, str] | None = None) -> dict[str, str]:
    """
    移除 *_KEY / *_SECRET / *_TOKEN / *_PASSWORD 类环境变量，避免 agent 误把上游
    API key 透出到子进程（Open Interpreter 已知踩过这个坑）。
    """
    src = env if env is not None else dict(os.environ)
    out: dict[str, str] = {}
    for k, v in src.items():
        if SENSITIVE_ENV_PATTERN.match(k):
            out[k] = "<redacted>"
        else:
            out[k] = v
    return out


def evaluate_shell_command(
    command: str,
    *,
    shell: str | None = None,
    allow_destructive: bool = False,
    allowlist: dict[str, set[str]] | None = None,
    denylist: set[str] | None = None,
    deny_patterns: list[re.Pattern[str]] | None = None,
) -> ShellDecision:
    """
    对一条 shell 命令做静态判定。返回 ShellDecision，由 stdio_worker 决定是否执行。
    纯函数，不发起任何 IO。
    """
    allowlist = allowlist or DEFAULT_ALLOWLIST
    denylist = denylist or DEFAULT_DENYLIST
    deny_patterns = deny_patterns or DEFAULT_DENY_PATTERNS

    detected = _detect_shell(shell)
    decision = ShellDecision(
        allowed=False,
        detected_shell=detected,
        sanitized_command=command,
        sanitized_env=sanitize_env(),
    )

    if not command or not command.strip():
        decision.reason = "命令为空"
        return decision

    first = _first_token(command)
    decision.first_token = first

    # 黑名单短路
    if first and first.lower() in {d.lower() for d in denylist}:
        decision.reason = f"命令 {first!r} 在黑名单中（破坏性/高危操作）"
        return decision

    # 高危 regex 命中
    for pat in deny_patterns:
        if pat.search(command):
            decision.reason = f"匹配高危模式 {pat.pattern!r}"
            return decision

    # 白名单匹配：first token 在任一 bucket 命中即过（dir / cat / ls 等跨 shell 别名场景）
    if first:
        first_lc = first.lower()
        for bucket_name, bucket in allowlist.items():
            if first_lc in {b.lower() for b in bucket}:
                decision.allowed = True
                decision.reason = f"白名单命中 {bucket_name}/{first}"
                return decision

    # allowDestructive=true 时：仅做黑名单 + regex 校验，跳过白名单
    if allow_destructive:
        decision.allowed = True
        decision.reason = "allowDestructive=true 跳过白名单"
        return decision

    decision.reason = (
        f"未在 {detected} 白名单中（首 token={first!r}）。"
        "若确需执行，调用方需传 allowDestructive=true 并在服务端开 DESKTOP_SHELL_ALLOWLIST=0"
    )
    return decision


def format_command_for_log(command: str, max_len: int = 400) -> str:
    """日志用：截断+清洗。"""
    s = command.replace("\r", " ").replace("\n", " ")
    if len(s) > max_len:
        s = s[:max_len] + "...<truncated>"
    return s

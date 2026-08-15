from __future__ import annotations

import re
from hashlib import sha1

from tool_router.models import ParsedIntent, QueryConstraints


class IntentRouter:
    def __init__(self) -> None:
        self.cache: dict[str, ParsedIntent] = {}

    def decompose(self, raw_user_query: str, agent_context_hash: str) -> ParsedIntent:
        cache_key = self._cache_key(raw_user_query, agent_context_hash)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached.model_copy(deep=True)

        query = raw_user_query.strip()
        parts = self._split_compound(query)
        if len(parts) > 1:
            sub_intents = [self._route_single(part) for part in parts]
            intent = ParsedIntent(
                intent=query,
                domain_candidates=self._unique([d for item in sub_intents for d in item.domain_candidates]) or ["misc"],
                primary_capability=sub_intents[0].primary_capability,
                confidence=min(0.95, max(item.confidence for item in sub_intents)),
                query_constraints=sub_intents[0].query_constraints,
                param_extract={},
                is_compound_task=True,
                sub_intents=sub_intents,
            )
            self.cache[cache_key] = intent
            return intent.model_copy(deep=True)
        intent = self._route_single(query)
        self.cache[cache_key] = intent
        return intent.model_copy(deep=True)

    def _route_single(self, query: str) -> ParsedIntent:
        domains = self._domains_from_query(query)
        primary_domain = domains[0] if domains else "misc"
        primary_capability = f"{primary_domain}.{self._infer_action(query)}"
        confidence = 0.9 if len(query.split()) > 5 else 0.7
        return ParsedIntent(
            intent=query,
            domain_candidates=domains or ["misc"],
            primary_capability=primary_capability,
            confidence=confidence,
            query_constraints=self._infer_constraints(query),
            param_extract=self._extract_params(query),
            is_compound_task=False,
            sub_intents=[],
        )

    @staticmethod
    def _split_compound(query: str) -> list[str]:
        parts = [part.strip() for part in re.split(r"\b(?:and|then|同时|然后|并且|以及)\b|[;,，；]", query) if part.strip()]
        return [part for part in parts if len(part) >= 2]

    @staticmethod
    def _domains_from_query(query: str) -> list[str]:
        q = query.lower()
        rules: list[tuple[re.Pattern[str], list[str]]] = [
            (re.compile(r"\bmcp\b|\bintegration\b|\bexternal\b"), ["mcp"]),
            (re.compile(r"\bweather\b|\bforecast\b|\btemperature\b"), ["weather"]),
            (re.compile(r"\brain\b|\bwind\b|\bhumidity\b"), ["weather"]),
            (re.compile(r"\bcalendar\b|\bschedule\b|\bmeeting\b|\btask\b|\btodo\b"), ["calendar", "reminder"]),
            (re.compile(r"\bremind\b|\breminder\b"), ["reminder"]),
            (re.compile(r"\bsearch\b|\bgoogle\b|\bnews\b|\bfind\b"), ["search"]),
            (re.compile(r"\bread\b|\bfetch\b|\bcontent\b"), ["browser", "search"]),
            (re.compile(r"\bweb\b|\bbrowser\b|\burl\b|\bpage\b"), ["browser", "search"]),
            (re.compile(r"\btab\b|\btabs\b"), ["browser"]),
            (re.compile(r"\bphone\b|\bcall\b|\bsms\b|\bmessage\b"), ["phone"]),
            (re.compile(r"\bfriend request\b|\bpeer\b"), ["agent"]),
            (re.compile(r"\bwallet\b|\bpayment\b|\bbalance\b|\bshopping\b|\bbudget\b"), ["wallet", "budget", "shopping"]),
            (re.compile(r"\brecommend\b|\bbuy\b|\blaptop\b"), ["shopping"]),
            (re.compile(r"\bdesktop\b|\bshell\b|\bautomation\b|\bwindow\b"), ["desktop"]),
            (re.compile(r"\bavatar\b|\bembodiment\b|\broam\b"), ["embodiment"]),
            (re.compile(r"\bskill\b|\bcapabilit(?:y|ies)\b|\bcustom\b"), ["self", "agent"]),
            (re.compile(r"\bworld\b|\bregistry\b|\bagent\b"), ["world", "agent"]),
            (re.compile(r"\btravel\b|\btrip\b|\bitinerary\b"), ["travel"]),
            (re.compile(r"\btime\b|\bclock\b|\bdate\b"), ["clock"]),
            (re.compile(r"\baip\b|\bprotocol\b"), ["aip"]),
            # ---- 中文领域规则（具体 → 通用，避免"查询"被通用 search 截胡）----
            (re.compile(r"天气|气温|温度|降雨|下雨|降水|预报|湿度|台风|风力|晴天|多云"), ["weather"]),
            (re.compile(r"日历|日程|会议|开会|有没有会|有会|预约|待办|排期|行程安排"), ["calendar", "reminder"]),
            (re.compile(r"提醒|闹钟|定时|稍后|到点|催我"), ["reminder"]),
            (re.compile(r"打电话|电话|拨号|短信|发短信|呼叫|通讯录|通话"), ["phone"]),
            (re.compile(r"钱包|余额|支付|付款|转账|充值|账单|扣款|收款"), ["wallet"]),
            (re.compile(r"买|购买|购物|下单|商品|商城|推荐|种草|笔记本|电脑|手机|耳机|相机|平板|家电"), ["shopping"]),
            (re.compile(r"预算|记账|开支|花费|理财|报销"), ["budget", "wallet"]),
            (re.compile(r"桌面|自动化|窗口|脚本|鼠标|键盘|点击|截图"), ["desktop"]),
            (re.compile(r"悬浮|桌宠|头像|漫游|移动窗口|放置窗口|漂移"), ["embodiment"]),
            (re.compile(r"技能|自定义能力|我的能力|能力列表"), ["self", "agent"]),
            (re.compile(r"好友|添加好友|好友请求|另一个智能体|发送给.{0,6}智能体"), ["agent"]),
            (re.compile(r"世界|注册中心|广场|市场"), ["world", "agent"]),
            (re.compile(r"旅行|旅游|机票|酒店|行程|航班|出行|订票"), ["travel"]),
            (re.compile(r"时间|几点|日期|今天几号|钟表|现在.*(点|时)"), ["clock"]),
            (re.compile(r"网页|浏览器|网址|页面|网站|打开.{0,6}(网页|网站|链接)|访问"), ["browser", "search"]),
            (re.compile(r"搜索|查找|查一下|查查|资讯|新闻|谷歌|百度|资料|内容"), ["search"]),
            (re.compile(r"读取|抓取|下载|内容|正文"), ["browser", "search"]),
            (re.compile(r"mcp|外部服务|集成|接入"), ["mcp"]),
            (re.compile(r"aip|协议"), ["aip"]),
        ]
        out: list[str] = []
        for pattern, domains in rules:
            if pattern.search(q):
                out.extend(domains)
        return IntentRouter._unique(out)

    @staticmethod
    def _infer_action(query: str) -> str:
        q = query.lower()
        if re.search(r"\bfriend request\b|\binvite\b", q):
            return "request"
        if re.search(r"\bregister\b", q):
            return "register"
        if re.search(r"\bextract\b|\bparse\b", q):
            return "extract"
        if re.search(r"\bsearch\b|\bgoogle\b|\blookup\b", q):
            return "search"
        if re.search(r"\bread\b|\bfetch\b", q):
            return "read"
        if re.search(r"\bplan\b", q):
            return "plan"
        if re.search(r"\bsend\b", q):
            return "send"
        if re.search(r"\bcreate\b|\badd\b|\bschedule\b|\bset\b", q):
            return "create"
        if re.search(r"\brun\b|\bexecute\b|\bcall\b|\bdispatch\b", q):
            return "execute"
        if re.search(r"\bopen\b|\bnavigate\b|\bbrowse\b", q):
            return "navigate"
        if re.search(r"\blist\b|\bshow\b", q):
            return "list"
        # ---- 中文动作推断 ----
        if re.search(r"邀请|好友请求|加.{0,4}好友", q):
            return "request"
        if re.search(r"注册|登记|入驻", q):
            return "register"
        if re.search(r"提取|解析|识别", q):
            return "extract"
        if re.search(r"搜索|查找|查一下|查查|搜|谷歌|百度|查询", q):
            return "search"
        if re.search(r"读取|抓取|下载|看内容|正文", q):
            return "read"
        if re.search(r"提醒|计划|安排|预约|规划", q):
            return "plan"
        if re.search(r"发送|发消息|转发|发给|发.{0,3}短信|打个电话|拨号|呼叫", q):
            return "send"
        if re.search(r"创建|新建|添加|设置|设定|建个|定个", q):
            return "create"
        if re.search(r"执行|运行|调用|跑|启动|漫游", q):
            return "execute"
        if re.search(r"打开|访问|进入|打开网页", q):
            return "navigate"
        if re.search(r"列表|列出|展示|看看有|查有哪些|显示", q):
            return "list"
        if re.search(r"推荐|预订|订|买|购买|下单|创建订单", q):
            return "create"
        return "query"

    @staticmethod
    def _infer_constraints(query: str) -> QueryConstraints:
        q = query.lower()
        return QueryConstraints(
            max_latency_ms=100 if "fast" in q or "quick" in q or "快点" in q or "尽快" in q else 200,
            read_only=not bool(
                re.search(
                    r"\bcreate\b|\bupdate\b|\bdelete\b|\bsend\b|\bexecute\b|\bextract\b|\bparse\b|\bplan\b|\bschedule\b|\bset\b"
                    r"|创建|新建|添加|设置|删除|取消|发送|发.{0,3}短信|打个电话|拨号|呼叫|执行|提取|解析|提醒|安排|预约|计划|注册|转账|支付|下单|购买|买",
                    q,
                )
            ),
            file_type="pdf" if "pdf" in q else None,
        )

    @staticmethod
    def _extract_params(query: str) -> dict[str, str]:
        words = query.split()
        return {"query_text": query, "keyword": words[-1] if words else ""}

    @staticmethod
    def _unique(values: list[str]) -> list[str]:
        out: list[str] = []
        for value in values:
            if value not in out:
                out.append(value)
        return out

    @staticmethod
    def _cache_key(raw_user_query: str, agent_context_hash: str) -> str:
        return sha1(f"{raw_user_query}\0{agent_context_hash}".encode("utf-8")).hexdigest()

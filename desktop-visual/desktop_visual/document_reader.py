"""文档文本提取（read_document action 的纯逻辑部分，可独立单测）。

支持：
- 纯文本类（.txt/.md/.log/.json/.csv/.py 等多编码尝试读取）
- PDF（pypdf → PyPDF2 降级；未安装时报可读错误）
- .docx（zipfile + 正则去 XML 标签，纯标准库）

路径解析：
- 优先把 windowTitle 里提取到的完整路径直接用
- 只有文件名时在常见目录（桌面/文档/下载，含 OneDrive 变体）搜索同名文件
"""
from __future__ import annotations

import re
import zipfile
from pathlib import Path

# 支持提取文本的扩展名分类
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".log", ".json", ".csv", ".tsv", ".srt",
    ".yaml", ".yml", ".ini", ".toml", ".xml", ".html", ".htm",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h", ".cs",
    ".go", ".rs", ".rb", ".php", ".sql", ".sh", ".bat", ".ps1",
}
PDF_EXTS = {".pdf"}
DOCX_EXTS = {".docx"}
PPTX_EXTS = {".pptx"}
SUPPORTED_EXTS = TEXT_EXTS | PDF_EXTS | DOCX_EXTS | PPTX_EXTS

# 支持的扩展名（用于从窗口标题提取文件名）
_EXT_PATTERN = re.compile(
    r"([A-Za-z]:\\[^<>:\"/|?*\r\n]+?|[^\\/|<>:\"?*\r\n]+?)\.(" + "|".join(
        ext.lstrip(".") for ext in sorted(SUPPORTED_EXTS, key=len, reverse=True)
    ) + r")\b",
    re.IGNORECASE,
)

# 文件名搜索目录（相对用户主目录；含 OneDrive 变体）
DEFAULT_SEARCH_DIRS = (
    "Desktop", "Documents", "Downloads",
    "OneDrive/Desktop", "OneDrive/Documents", "OneDrive/Downloads",
    "Desktop/桌面", "Documents/文档",
)

DEFAULT_MAX_CHARS = 16_000
MAX_CHARS_CAP = 60_000


def extract_document_reference(title: str) -> dict | None:
    """从窗口标题提取文档线索。

    返回 {"filePath": 完整路径或 None, "fileName": xxx.ext}；标题里没有可识别
    文档名时返回 None。
    """
    if not title:
        return None
    m = _EXT_PATTERN.search(title)
    if not m:
        return None
    raw = m.group(1).strip().strip("'\"")
    ext = "." + m.group(2).lower()
    # 完整路径（盘符开头）
    if re.match(r"^[A-Za-z]:\\", raw):
        return {"filePath": raw + ext, "fileName": Path(raw + ext).name}
    return {"filePath": None, "fileName": raw + ext}


def _iter_search_dirs(search_dirs: list[str] | tuple[str, ...] | None) -> list[Path]:
    if search_dirs:
        return [Path(d) for d in search_dirs]
    home = Path.home()
    return [home / d for d in DEFAULT_SEARCH_DIRS]


def resolve_document_path(
    raw: str,
    search_dirs: list[str] | tuple[str, ...] | None = None,
) -> Path | None:
    """把「路径或文件名」解析为真实存在的文件。

    完整路径直接用；裸文件名在常见目录精确匹配（大小写不敏感的 Windows 上
    直接相等即可）。找不到返回 None。
    """
    if not raw or not raw.strip():
        return None
    candidate = Path(raw.strip().strip("'\""))
    if candidate.is_absolute() or candidate.exists():
        return candidate if candidate.is_file() else None
    # 裸文件名 → 常见目录搜索
    name = candidate.name
    for base in _iter_search_dirs(search_dirs):
        try:
            hit = base / name
            if hit.is_file():
                return hit
        except OSError:
            continue
    return None


def _read_text_file(path: Path, max_chars: int) -> tuple[str, bool]:
    """多编码尝试读取纯文本文件，返回 (text, truncated)。"""
    data = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "utf-16", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except (UnicodeDecodeError, ValueError):
            continue
    else:
        text = data.decode("utf-8", errors="replace")
    if len(text) > max_chars:
        return text[:max_chars], True
    return text, False


def extract_pdf_text(path: Path, max_chars: int) -> dict:
    """PDF → 文本。pypdf 优先，PyPDF2 降级；都没装返回可读错误。"""
    extractor = None
    mod_err = ""
    try:
        import pypdf  # type: ignore[import-not-found]

        extractor = "pypdf"
        reader = pypdf.PdfReader(str(path))
    except ImportError:
        try:
            import PyPDF2  # type: ignore[import-not-found]

            extractor = "PyPDF2"
            reader = PyPDF2.PdfReader(str(path))
        except ImportError:
            return {
                "ok": False,
                "error": "PDF 文本提取需要 pypdf（pip install pypdf）后重试",
            }
        except Exception as exc:  # PyPDF2 打开失败
            return {"ok": False, "error": f"PDF 打开失败: {exc}"}
    except Exception as exc:
        return {"ok": False, "error": f"PDF 打开失败: {exc}"}
    if mod_err:
        return {"ok": False, "error": mod_err}

    pages: list[str] = []
    total = 0
    truncated = False
    try:
        page_count = len(reader.pages)
    except Exception as exc:
        return {"ok": False, "error": f"PDF 页数读取失败: {exc}"}
    for page in reader.pages:
        if total >= max_chars:
            truncated = True
            break
        try:
            chunk = page.extract_text() or ""
        except Exception:
            chunk = ""
        pages.append(chunk)
        total += len(chunk)
    text = "\n".join(pages)[:max_chars]
    if total > max_chars:
        truncated = True
    result: dict = {
        "ok": True,
        "ext": ".pdf",
        "text": text,
        "pages": page_count,
        "chars": len(text),
        "truncated": truncated,
    }
    if not text.strip():
        result["ok"] = False
        result["error"] = "PDF 未提取到文本（可能是扫描件，需要 OCR）"
    return result


def extract_docx_text(path: Path, max_chars: int) -> dict:
    """docx → 文本（zipfile 读 word/document.xml 后去标签，纯标准库）。"""
    try:
        with zipfile.ZipFile(path) as zf:
            xml = zf.read("word/document.xml").decode("utf-8", errors="replace")
    except KeyError:
        return {"ok": False, "error": "docx 缺少 word/document.xml（可能不是标准 docx）"}
    except Exception as exc:
        return {"ok": False, "error": f"docx 读取失败: {exc}"}
    # 段落/换行 → 换行符，其余标签去除，再反转义基本实体
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
    xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    text = (
        text.replace("&lt;", "<").replace("&gt;", ">")
        .replace("&amp;", "&").replace("&quot;", '"').replace("&apos;", "'")
    )
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    truncated = len(text) > max_chars
    text = text[:max_chars]
    return {
        "ok": True,
        "ext": ".docx",
        "text": text,
        "chars": len(text),
        "truncated": truncated,
    }


_PPTX_TEXT_TAG = re.compile(r"<a:t>([^<]*)</a:t>")
_PPTX_UNESCAPE = (
    ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
    ("&apos;", "'"), ("&amp;", "&"),
)


def extract_pptx_text(path: Path, max_chars: int) -> dict:
    """pptx → 文本（读 ppt/slides/*.xml + ppt/notesSlides/*.xml 的 <a:t> 文本运行）。"""
    parts: list[str] = []
    try:
        with zipfile.ZipFile(path) as zf:
            slide_names = sorted(
                n for n in zf.namelist()
                if (n.startswith("ppt/slides/slide") or n.startswith("ppt/notesSlides/"))
                and n.endswith(".xml")
            )
            for name in slide_names:
                xml = zf.read(name).decode("utf-8", errors="replace")
                runs = _PPTX_TEXT_TAG.findall(xml)
                if runs:
                    for raw in runs:
                        for ent, ch in _PPTX_UNESCAPE:
                            raw = raw.replace(ent, ch)
                        parts.append(raw)
                    parts.append("\n")
    except Exception as exc:
        return {"ok": False, "error": f"pptx 读取失败: {exc}"}
    if not slide_names:
        return {"ok": False, "error": "pptx 缺少 ppt/slides/*.xml（可能不是标准 pptx）"}
    text = "".join(parts)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    truncated = len(text) > max_chars
    text = text[:max_chars]
    return {
        "ok": True,
        "ext": ".pptx",
        "text": text,
        "chars": len(text),
        "truncated": truncated,
    }


def read_document(
    path: str,
    max_chars: int = DEFAULT_MAX_CHARS,
    search_dirs: list[str] | tuple[str, ...] | None = None,
) -> dict:
    """read_document action 主入口：解析路径 → 按扩展名提取文本。

    返回统一结构 {ok, path?, title?, ext?, text?, chars?, pages?, truncated?, error?}。
    """
    try:
        max_chars = max(500, min(int(max_chars or DEFAULT_MAX_CHARS), MAX_CHARS_CAP))
    except (TypeError, ValueError):
        max_chars = DEFAULT_MAX_CHARS

    resolved = resolve_document_path(path, search_dirs)
    if resolved is None:
        return {
            "ok": False,
            "error": f"无法定位文件: {path!r}（支持完整路径，或桌面/文档/下载目录下的文件名）",
        }
    resolved = resolved.resolve()
    ext = resolved.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        return {
            "ok": False,
            "path": str(resolved),
            "error": f"不支持的文档类型 {ext!r}（支持: 文本类/pdf/docx）",
        }

    base = {"path": str(resolved), "title": resolved.stem}
    if ext in PDF_EXTS:
        return {**base, **extract_pdf_text(resolved, max_chars)}
    if ext in DOCX_EXTS:
        return {**base, **extract_docx_text(resolved, max_chars)}
    if ext in PPTX_EXTS:
        return {**base, **extract_pptx_text(resolved, max_chars)}
    # 纯文本类
    try:
        text, truncated = _read_text_file(resolved, max_chars)
    except OSError as exc:
        return {**base, "ok": False, "error": f"文件读取失败: {exc}"}
    return {
        **base,
        "ok": True,
        "ext": ext,
        "text": text,
        "chars": len(text),
        "truncated": truncated,
    }


def supported_reference(title: str) -> bool:
    """窗口标题里是否含可识别的文档名（供测试与快速判断）。"""
    return extract_document_reference(title) is not None

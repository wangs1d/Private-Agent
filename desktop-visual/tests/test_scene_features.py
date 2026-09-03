"""情境感知新增能力的纯逻辑测试：read_document / set_dnd / 桥接白名单。

运行：cd desktop-visual && py -3.12 -m pytest tests -q
"""
from __future__ import annotations

import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from desktop_visual.bridge_actions import ACTION_FIELD_ALLOWLIST, build_worker_request
from desktop_visual.document_reader import (
    extract_document_reference,
    read_document,
    resolve_document_path,
)
from desktop_visual import notifications_policy as dnd


# ─── 桥接白名单 ────────────────────────────────────────────────────────────


class TestSceneBridgeActions:
    def test_scene_actions_registered(self):
        assert "read_document" in ACTION_FIELD_ALLOWLIST
        assert "set_dnd" in ACTION_FIELD_ALLOWLIST

    def test_read_document_field_allowlist(self):
        req = build_worker_request({"action": "read_document", "path": "a.pdf", "maxChars": 100, "evil": 1})
        assert req == {"action": "read_document", "path": "a.pdf", "maxChars": 100}

    def test_set_dnd_field_allowlist(self):
        req = build_worker_request({"action": "set_dnd", "dndOp": "enable", "evil": 1})
        assert req == {"action": "set_dnd", "dndOp": "enable"}


# ─── document_reader ───────────────────────────────────────────────────────


class TestExtractDocumentReference:
    def test_full_path_in_title(self):
        ref = extract_document_reference("C:\\Users\\me\\a b\\report.pdf - Adobe Acrobat")
        assert ref is not None
        assert ref["filePath"] == "C:\\Users\\me\\a b\\report.pdf"
        assert ref["fileName"] == "report.pdf"

    def test_bare_filename_in_title(self):
        ref = extract_document_reference("毕业论文.docx - Microsoft Word")
        assert ref is not None
        assert ref["filePath"] is None
        assert ref["fileName"] == "毕业论文.docx"

    def test_no_document_in_title(self):
        assert extract_document_reference("知乎 - 有问题就会有答案") is None
        assert extract_document_reference("") is None

    def test_supported_exts(self):
        for name in ("a.pdf", "b.docx", "c.txt", "d.md", "e.pptx"):
            assert extract_document_reference(f"{name} - 阅读器") is not None, name


class TestResolveDocumentPath:
    def test_absolute_path(self, tmp_path):
        f = tmp_path / "x.txt"
        f.write_text("hello", encoding="utf-8")
        assert resolve_document_path(str(f)) == f

    def test_bare_name_searched_in_dirs(self, tmp_path):
        downloads = tmp_path / "Downloads"
        downloads.mkdir()
        (downloads / "report.pdf").write_bytes(b"%PDF-1.4")
        hit = resolve_document_path("report.pdf", search_dirs=[str(downloads)])
        assert hit is not None and hit.name == "report.pdf"

    def test_missing_returns_none(self, tmp_path):
        assert resolve_document_path("no_such_file_12345.pdf", search_dirs=[str(tmp_path)]) is None


class TestReadDocument:
    def test_text_file_multilingual(self, tmp_path):
        f = tmp_path / "n.txt"
        f.write_text("第一行\nsecond line\n", encoding="utf-8")
        out = read_document(str(f))
        assert out["ok"] is True
        assert "second line" in out["text"]
        assert out["chars"] == len(out["text"])

    def test_max_chars_truncates(self, tmp_path):
        f = tmp_path / "big.txt"
        f.write_text("x" * 5000, encoding="utf-8")
        out = read_document(str(f), max_chars=1000)
        assert out["ok"] is True
        assert out["truncated"] is True
        assert len(out["text"]) == 1000

    def test_docx_extraction(self, tmp_path):
        # 手工构造一个最小 docx（zip + word/document.xml）
        f = tmp_path / "doc.docx"
        xml = (
            '<?xml version="1.0"?><w:document xmlns:w="w">'
            "<w:body><w:p><w:r><w:t>标题段落</w:t></w:r></w:p>"
            "<w:p><w:r><w:t>正文段落&amp;符号</w:t></w:r></w:p>"
            "</w:body></w:document>"
        )
        with zipfile.ZipFile(f, "w") as zf:
            zf.writestr("word/document.xml", xml)
        out = read_document(str(f))
        assert out["ok"] is True
        assert "标题段落" in out["text"]
        assert "正文段落&符号" in out["text"]
        assert out["text"].count("\n") >= 1

    def test_unsupported_ext(self, tmp_path):
        f = tmp_path / "v.exe"
        f.write_bytes(b"MZ")
        out = read_document(str(f))
        assert out["ok"] is False
        assert "不支持" in out["error"]

    def test_missing_file_error(self, tmp_path):
        out = read_document("definitely_missing_98765.pdf", search_dirs=[str(tmp_path)])
        assert out["ok"] is False
        assert "无法定位" in out["error"]

    def test_gbk_decoded(self, tmp_path):
        f = tmp_path / "gbk.txt"
        f.write_bytes("中文内容".encode("gb18030"))
        out = read_document(str(f))
        assert out["ok"] is True
        assert "中文内容" in out["text"]


# ─── notifications_policy（mock 注册表读写，不碰真实系统） ──────────────────


class TestSetDnd:
    def test_invalid_op_rejected(self):
        out = dnd.set_dnd("destroy_notifications")
        assert out["ok"] is False
        assert "dndOp" in out["error"]

    def test_enable_records_previous_and_disable_restores(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dnd, "STATE_FILE", tmp_path / "state.json")
        current = {"value": 1}
        monkeypatch.setattr(dnd, "_read_toasts_enabled", lambda: current["value"])
        monkeypatch.setattr(dnd, "_write_toasts_enabled", lambda v: current.__setitem__("value", v) or True)

        out = dnd.set_dnd("enable")
        assert out["ok"] is True and out["previous"] == 1 and current["value"] == 0

        out = dnd.set_dnd("disable")
        assert out["ok"] is True and current["value"] == 1
        assert not dnd.STATE_FILE.exists()

    def test_enable_twice_keeps_first_previous(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dnd, "STATE_FILE", tmp_path / "state.json")
        current = {"value": 1}
        monkeypatch.setattr(dnd, "_read_toasts_enabled", lambda: current["value"])
        monkeypatch.setattr(dnd, "_write_toasts_enabled", lambda v: current.__setitem__("value", v) or True)

        dnd.set_dnd("enable")
        current["value"] = 1  # 模拟用户手动恢复
        out = dnd.set_dnd("enable")
        assert out["ok"] is True and out["previous"] == 1

    def test_write_failure_reports_error(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dnd, "STATE_FILE", tmp_path / "state.json")
        monkeypatch.setattr(dnd, "_read_toasts_enabled", lambda: 1)
        monkeypatch.setattr(dnd, "_write_toasts_enabled", lambda v: False)
        out = dnd.set_dnd("enable")
        assert out["ok"] is False
        assert "失败" in out["error"]

    def test_registry_unreachable(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dnd, "STATE_FILE", tmp_path / "state.json")
        monkeypatch.setattr(dnd, "_read_toasts_enabled", lambda: None)
        out = dnd.set_dnd("enable")
        assert out["ok"] is False

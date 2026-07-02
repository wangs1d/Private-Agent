# D 盘缓存与下载目录约定

> 任何在运行期需要写 **模型 / 缓存 / 临时文件** 的子进程,都强制落 D 盘,严禁写 C 盘。

## 顶层目录

```
D:\paddle\
├── paddleocr\   # PaddleOCR 模型 (PPOCR_HOME)
├── paddlex\     # PaddleX 自带缓存(func_ret / locks / temp / official_models)
├── pip\         # pip 下载缓存 (PIP_CACHE_DIR)
├── hf\          # HuggingFace 缓存 (HF_HOME / HUGGINGFACE_HUB_CACHE)
│   └── hub\
└── tmp\         # Python / Paddle inference 临时文件 (TEMP / TMP / TMPDIR)
```

## 双重保险

1. **环境变量**:在 [scripts/redirect-paddle-cache-to-d.cmd](../../scripts/redirect-paddle-cache-to-d.cmd) 写用户级环境变量。`paddle_ocr_server.py` / `pip` 等运行时组件都会读这些变量。
2. **目录联结(Junction)**:`mklink /J` 把 C 盘默认路径(`C:\Users\Administrator\.paddlex`、`C:\Users\Administrator\AppData\Local\pip`)指向 D 盘。**即使程序完全忽略环境变量、只认 C 盘默认路径,实际也会写到 D 盘。**

## 开机/迁移后一键修复

在管理员权限 PowerShell 或 cmd 里跑:

```bat
E:\ws-project\Private-Agent\scripts\redirect-paddle-cache-to-d.cmd
```

脚本做的事:
1. 建 `D:\paddle\{paddleocr,paddlex,pip,hf,tmp}`
2. 缺哪条 junction 就补哪条
3. 重写用户级环境变量

## C 盘已有的相关目录(均已通过 junction 接到 D 盘)

| C 盘路径 | junction 目标 |
|---|---|
| `C:\Users\Administrator\.paddlex` | `D:\paddle\paddlex` |
| `C:\Users\Administrator\AppData\Local\pip` | `D:\paddle\pip` |

`C:\Users\Administrator\.paddleocr` 不存在(本来就没下过 PaddleOCR 模型);以后如果 PaddleX 又新建了 `.paddleocr` 之类的默认目录,在脚本里加一行 `mklink /J` 即可。

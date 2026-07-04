"""Cat-Cut desktop app paths (Electron userData 相当).

desktop/main/index.cjs の app.getPath('userData') と同じディレクトリを
ヘッドレス Python パイプラインから参照する。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# desktop/package.json の name と一致 (Electron userData ディレクトリ名)
APP_DIR_NAME = "cat-cut-desktop"


def default_user_data_dir() -> Path:
    """Electron app.getPath('userData') の既定パス。"""
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / APP_DIR_NAME
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        base = Path(appdata) if appdata else home / "AppData" / "Roaming"
        return base / APP_DIR_NAME
    return home / ".config" / APP_DIR_NAME


def default_user_dictionary_path() -> Path:
    return default_user_data_dir() / "user_dictionary.json"

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    project_root = Path(__file__).resolve().parent
    script_path = project_root / "scripts" / "generate_app_icons.swift"
    env = dict(os.environ)
    env.setdefault("CLANG_MODULE_CACHE_PATH", "/tmp/canopy-swift-module-cache")

    try:
        subprocess.run(
            ["swift", str(script_path)],
            cwd=project_root,
            env=env,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        return exc.returncode
    except FileNotFoundError:
        print("Swift is required to generate Canopy app icons.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

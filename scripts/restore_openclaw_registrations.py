#!/usr/bin/env python3
import argparse
import json
import sqlite3
import subprocess
from pathlib import Path
from typing import Dict, List, Optional


def load_agents(db_path: Path) -> List[Dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        select id, isolated, personality_json
        from agents
        where status = 'active' and paused = 0
        order by id
        """
    ).fetchall()
    conn.close()

    agents = []
    for row in rows:
        personality = json.loads(row["personality_json"] or "{}")
        agents.append(
            {
                "id": row["id"],
                "isolated": bool(row["isolated"]),
                "model": (personality.get("active_model") or "").strip(),
            }
        )
    return agents


def container_name(agent: Dict) -> str:
    if agent["isolated"]:
        return "canopy-isolated-{}".format(agent["id"])
    return "canopy-gateway"


def restore_agent(agent: Dict) -> subprocess.CompletedProcess:
    workspace = "/home/node/.openclaw/workspace/{}".format(agent["id"])
    cmd = [
        "docker",
        "exec",
        "-u",
        "node",
        "-e",
        "NODE_OPTIONS=--v8-pool-size=1 --max-old-space-size=512",
        container_name(agent),
        "openclaw",
        "agents",
        "add",
        agent["id"],
        "--workspace",
        workspace,
    ]
    if agent["model"]:
        cmd.extend(["--model", agent["model"]])
    return subprocess.run(cmd, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--canopy-root", default=str(Path.home() / "Library" / "Application Support" / "Canopy"))
    args = parser.parse_args()

    db_path = Path(args.canopy_root) / "canopy.db"
    agents = load_agents(db_path)

    failures = []
    for agent in agents:
        result = restore_agent(agent)
        combined = "{}{}".format(result.stdout, result.stderr).strip()
        if result.returncode == 0 or "already exists" in combined.lower():
            print("restored {}".format(agent["id"]))
        else:
            failures.append((agent["id"], result.returncode, combined))
            print("failed {}: exit {}".format(agent["id"], result.returncode))

    if failures:
        print("\nFailures:")
        for agent_id, code, output in failures:
            print("- {} (exit {})".format(agent_id, code))
            print(output)
        return 1

    print("\nRestored {} agents".format(len(agents)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

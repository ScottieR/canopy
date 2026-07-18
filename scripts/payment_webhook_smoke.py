#!/usr/bin/env python3
"""Send a signed local payment webhook to Canopy's payment listener."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def hmac_base64(secret: bytes, message: bytes) -> str:
    digest = hmac.new(secret, message, hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


def build_privacy_payload(args: argparse.Namespace) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "token": args.card_ref,
        "transaction_token": args.transaction_ref or f"privacy-smoke-{uuid.uuid4()}",
        "amount": args.amount,
        "status": "CAPTURED" if args.outcome == "captured" else "DECLINED",
        "merchant": {"name": args.merchant},
        "event_type": args.event_type or f"privacy_smoke_{args.outcome}",
    }
    if args.outcome == "declined":
        payload["decline_reason"] = args.decline_reason or "smoke_decline"
        payload["result"] = args.decline_reason or "smoke_decline"
    return payload


def build_lithic_payload(args: argparse.Namespace) -> dict[str, Any]:
    transaction_ref = args.transaction_ref or f"lithic-smoke-{uuid.uuid4()}"
    payload: dict[str, Any] = {
        "card_token": args.card_ref,
        "token": transaction_ref,
        "transaction_token": transaction_ref,
        "amount": args.amount,
        "status": "CLEARED" if args.outcome == "captured" else "DECLINED",
        "merchant": {"name": args.merchant},
        "event_type": args.event_type or f"lithic_smoke_{args.outcome}",
    }
    if args.outcome == "declined":
        payload["decline_reason"] = args.decline_reason or "smoke_decline"
        payload["result"] = args.decline_reason or "smoke_decline"
    return {"payload": payload}


def build_request(args: argparse.Namespace) -> tuple[str, dict[str, str], bytes]:
    if args.provider == "privacy":
        url = args.url or os.environ.get("CANOPY_PRIVACY_WEBHOOK_URL")
        if not url:
            raise SystemExit(
                "Missing Privacy webhook URL. Pass --url using the local URL shown in Canopy, or set CANOPY_PRIVACY_WEBHOOK_URL."
            )
        payload = build_privacy_payload(args)
        body_text = canonical_json(payload)
        secret = args.secret or os.environ.get("PRIVACY_API_KEY")
        if not secret:
            raise SystemExit("Missing Privacy API key. Pass --secret or set PRIVACY_API_KEY.")
        headers = {
            "Content-Type": "application/json",
            "X-Privacy-HMAC": hmac_base64(secret.encode("utf-8"), body_text.encode("utf-8")),
        }
        return url, headers, body_text.encode("utf-8")

    url = args.url or os.environ.get("CANOPY_LITHIC_WEBHOOK_URL")
    if not url:
        raise SystemExit(
            "Missing Lithic webhook URL. Pass --url using the local URL shown in Canopy, or set CANOPY_LITHIC_WEBHOOK_URL."
        )
    payload = build_lithic_payload(args)
    body_text = canonical_json(payload)
    secret = args.secret or os.environ.get("LITHIC_WEBHOOK_SECRET")
    if not secret:
        raise SystemExit(
            "Missing Lithic webhook secret. Pass --secret or set LITHIC_WEBHOOK_SECRET."
        )
    if secret.startswith("whsec_"):
        secret = secret[len("whsec_") :]

    webhook_id = args.webhook_id or f"wh_{uuid.uuid4()}"
    timestamp = str(int(time.time()))
    signed_content = f"{webhook_id}.{timestamp}.{body_text}"
    headers = {
        "Content-Type": "application/json",
        "Webhook-Id": webhook_id,
        "Webhook-Timestamp": timestamp,
        "Webhook-Signature": f"v1,{hmac_base64(secret.encode('utf-8'), signed_content.encode('utf-8'))}",
    }
    return url, headers, body_text.encode("utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a signed payment webhook to Canopy's local listener."
    )
    parser.add_argument("--provider", choices=("privacy", "lithic"), required=True)
    parser.add_argument("--card-ref", required=True, help="Provider card token/reference.")
    parser.add_argument("--amount", type=int, required=True, help="Transaction amount in cents.")
    parser.add_argument("--merchant", default="Sandbox Merchant")
    parser.add_argument("--url", help="Override the local webhook URL.")
    parser.add_argument("--secret", help="Override the signing secret.")
    parser.add_argument("--transaction-ref", help="Optional stable provider transaction reference.")
    parser.add_argument("--event-type", help="Optional custom event type label.")
    parser.add_argument("--decline-reason", help="Optional decline reason for declined flows.")
    parser.add_argument("--webhook-id", help="Optional Lithic webhook id.")
    parser.add_argument(
        "--outcome",
        choices=("captured", "declined"),
        default="captured",
        help="Transaction outcome to simulate.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the signed request without sending it.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    url, headers, body = build_request(args)

    if args.dry_run:
        print(f"POST {url}")
        for key, value in headers.items():
            print(f"{key}: {value}")
        print()
        print(body.decode("utf-8"))
        return 0

    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            print(f"HTTP {response.status}")
            print(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        print(f"HTTP {error.code}", file=sys.stderr)
        print(response_body, file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Request failed: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

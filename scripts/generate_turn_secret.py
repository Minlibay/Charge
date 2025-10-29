#!/usr/bin/env python3
"""Generate high-entropy TURN shared secrets for Charge deployments."""

from __future__ import annotations

import argparse
import os
import re
import secrets
import sys
from pathlib import Path

DEFAULT_BYTE_LENGTH = 48
ENV_VAR_NAME = "WEBRTC_TURN_CREDENTIAL"


def generate_secret(byte_length: int) -> str:
    """Return a URL-safe secret with ~1.33 * byte_length characters."""
    if byte_length <= 0:
        msg = f"byte length must be positive (got {byte_length})"
        raise ValueError(msg)
    return secrets.token_urlsafe(byte_length)


def update_env_file(path: Path, secret: str) -> None:
    """Insert or replace the TURN credential in an env-style file."""
    lines: list[str]
    if path.exists():
        raw = path.read_text(encoding="utf-8").splitlines()
        pattern = re.compile(rf"^{re.escape(ENV_VAR_NAME)}=")
        replaced = False
        lines = []
        for line in raw:
            if pattern.match(line):
                lines.append(f"{ENV_VAR_NAME}={secret}")
                replaced = True
            else:
                lines.append(line)
        if not replaced:
            lines.append(f"{ENV_VAR_NAME}={secret}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [f"{ENV_VAR_NAME}={secret}"]

    content = "\n".join(lines) + "\n"
    path.write_text(content, encoding="utf-8")

    try:
        os.chmod(path, 0o600)
    except OSError:
        # Ignore permission errors on platforms that do not support chmod
        pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bytes",
        type=int,
        default=DEFAULT_BYTE_LENGTH,
        help=(
            "Number of random bytes to feed into token_urlsafe (roughly 4/3 of the"
            " resulting secret length)."
        ),
    )
    parser.add_argument(
        "--update-env",
        type=Path,
        metavar="PATH",
        help="Update or create the specified env file with the generated secret.",
    )
    parser.add_argument(
        "--silent",
        action="store_true",
        help="Do not print the secret to stdout (useful for CI rotations).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        secret = generate_secret(args.bytes)
    except ValueError as exc:  # pragma: no cover - defensive guard
        print(str(exc), file=sys.stderr)
        return 2

    if args.update_env:
        update_env_file(args.update_env, secret)
        print(
            f"Updated {args.update_env} with {ENV_VAR_NAME}.",
            file=sys.stderr,
        )

    if not args.silent:
        print(secret)

    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    sys.exit(main())

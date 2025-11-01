"""Utility for stress-testing Charge realtime websocket endpoints."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import signal
import statistics
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable

try:  # pragma: no cover - optional dependency
    import websockets
    from websockets.client import WebSocketClientProtocol
except Exception as exc:  # pragma: no cover - runtime guard
    raise SystemExit(
        "The 'websockets' package is required to run this load test tool."
    ) from exc


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class WorkerResult:
    """Outcome of a single websocket connection attempt."""

    connected: bool
    connect_latency: float | None = None
    messages_sent: int = 0
    messages_received: int = 0
    bytes_received: int = 0
    send_latencies: list[float] = field(default_factory=list)
    duration: float = 0.0
    timeouts: int = 0
    error: str | None = None


async def _send_payload(
    websocket: WebSocketClientProtocol,
    payload: str,
    *,
    expect_reply: bool,
    reply_timeout: float,
) -> tuple[float, int, int, int]:
    """Send a payload and optionally await a reply."""

    send_started = time.perf_counter()
    await websocket.send(payload)
    send_latency = time.perf_counter() - send_started

    messages_received = 0
    bytes_received = 0
    timeouts = 0
    if expect_reply:
        try:
            message = await asyncio.wait_for(websocket.recv(), timeout=reply_timeout)
        except asyncio.TimeoutError:
            timeouts += 1
        else:
            messages_received += 1
            if isinstance(message, str):
                bytes_received += len(message.encode("utf-8"))
            elif isinstance(message, (bytes, bytearray)):
                bytes_received += len(message)
    return send_latency, messages_received, bytes_received, timeouts


async def _worker(
    index: int,
    url: str,
    *,
    headers: Dict[str, str],
    session_duration: float,
    payload: str | None,
    interval: float,
    expect_reply: bool,
    reply_timeout: float,
    open_timeout: float,
    ping_interval: float | None,
) -> WorkerResult:
    """Maintain a websocket connection for the configured duration."""

    start_time = time.perf_counter()
    result = WorkerResult(connected=False)
    try:
        async with websockets.connect(
            url,
            extra_headers=headers,
            open_timeout=open_timeout,
            ping_interval=ping_interval,
        ) as websocket:
            connected_at = time.perf_counter()
            result.connected = True
            result.connect_latency = connected_at - start_time
            logger.debug("worker %s connected in %.3fs", index, result.connect_latency)

            deadline = connected_at + session_duration
            while time.perf_counter() < deadline:
                if payload is not None:
                    send_latency, received, bytes_read, timeout_count = await _send_payload(
                        websocket,
                        payload,
                        expect_reply=expect_reply,
                        reply_timeout=reply_timeout,
                    )
                    result.messages_sent += 1
                    result.messages_received += received
                    result.bytes_received += bytes_read
                    result.send_latencies.append(send_latency)
                    result.timeouts += timeout_count
                await asyncio.sleep(interval)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # pragma: no cover - network failures are non-deterministic
        result.error = f"{type(exc).__name__}: {exc}"
        logger.warning("worker %s failed: %s", index, result.error)
    finally:
        result.duration = time.perf_counter() - start_time
    return result


def _aggregate(results: Iterable[WorkerResult]) -> dict[str, Any]:
    """Compute summary metrics for all workers."""

    results = list(results)
    successes = [item for item in results if item.connected and item.error is None]
    failures = [item for item in results if item.error is not None or not item.connected]

    connection_latencies = [item.connect_latency for item in successes if item.connect_latency]
    send_latencies = [lat for item in successes for lat in item.send_latencies]

    def _stats(samples: list[float]) -> dict[str, float] | None:
        if not samples:
            return None
        samples_sorted = sorted(samples)
        count = len(samples_sorted)
        return {
            "avg": statistics.fmean(samples_sorted),
            "p50": statistics.median(samples_sorted),
            "p95": samples_sorted[int(0.95 * (count - 1))],
            "p99": samples_sorted[int(0.99 * (count - 1))],
            "max": samples_sorted[-1],
        }

    total_duration = sum(item.duration for item in successes)
    total_messages = sum(item.messages_sent for item in successes)
    throughput = (total_messages / total_duration) if total_duration else 0.0
    failure_reasons = Counter(item.error for item in failures if item.error)

    return {
        "attempted": len(results),
        "connected": len(successes),
        "failed": len(failures),
        "connection_latency": _stats(connection_latencies),
        "send_latency": _stats(send_latencies),
        "messages_sent": total_messages,
        "messages_received": sum(item.messages_received for item in successes),
        "bytes_received": sum(item.bytes_received for item in successes),
        "timeouts": sum(item.timeouts for item in successes),
        "throughput_per_second": throughput,
        "failures": dict(failure_reasons),
        "wall_clock_seconds": max((item.duration for item in results), default=0.0),
    }


async def run_load_test(args: argparse.Namespace) -> dict[str, Any]:
    """Entry point used by the CLI wrapper."""

    headers: Dict[str, str] = {}
    for raw in args.header:
        if ":" not in raw:
            logger.warning("ignoring malformed header: %s", raw)
            continue
        key, value = raw.split(":", 1)
        headers[key.strip()] = value.strip()
    if args.token:
        headers.setdefault("Authorization", f"Bearer {args.token}")

    logger.info(
        "starting load test: url=%s connections=%s duration=%ss payload=%s",
        args.url,
        args.connections,
        args.session_duration,
        "yes" if args.payload is not None else "no",
    )

    tasks = [
        asyncio.create_task(
            _worker(
                index,
                args.url,
                headers=headers,
                session_duration=args.session_duration,
                payload=args.payload,
                interval=args.interval,
                expect_reply=args.expect_reply,
                reply_timeout=args.reply_timeout,
                open_timeout=args.open_timeout,
                ping_interval=args.ping_interval,
            ),
            name=f"realtime-load-worker-{index}",
        )
        for index in range(args.connections)
    ]

    def _cancel(signum: int, _frame: Any) -> None:  # pragma: no cover - signal handling
        logger.warning("received signal %s, cancelling load test", signum)
        for task in tasks:
            task.cancel()

    handlers: dict[int, Any] = {}
    for signum in (signal.SIGINT, signal.SIGTERM):  # pragma: no cover - platform specific
        with contextlib.suppress(ValueError):
            handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, _cancel)

    try:
        results = await asyncio.gather(*tasks, return_exceptions=False)
    finally:
        for signum, previous in handlers.items():  # pragma: no cover - best effort cleanup
            with contextlib.suppress(ValueError):
                signal.signal(signum, previous)

    summary = _aggregate(results)
    logger.info(
        "load test finished: %s successes, %s failures", summary["connected"], summary["failed"]
    )
    return summary


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Websocket URL, e.g. ws://localhost:8000/ws/presence")
    parser.add_argument("--token", help="Bearer token used for authentication", default=None)
    parser.add_argument(
        "--connections",
        type=int,
        default=10,
        help="Number of concurrent websocket connections to open",
    )
    parser.add_argument(
        "--session-duration",
        type=float,
        default=30.0,
        help="How long each connection should stay open (seconds)",
    )
    parser.add_argument(
        "--payload",
        help="Optional JSON payload to send on each interval",
        default=None,
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=5.0,
        help="Delay between payload sends (seconds)",
    )
    parser.add_argument(
        "--expect-reply",
        action="store_true",
        help="Whether to wait for a reply after sending the payload",
    )
    parser.add_argument(
        "--reply-timeout",
        type=float,
        default=5.0,
        help="Timeout when waiting for replies (seconds)",
    )
    parser.add_argument(
        "--open-timeout",
        type=float,
        default=10.0,
        help="Timeout for establishing the websocket connection",
    )
    parser.add_argument(
        "--ping-interval",
        type=float,
        default=None,
        help="Interval between automatic websocket ping frames (seconds)",
    )
    parser.add_argument(
        "--header",
        action="append",
        default=[],
        help="Additional websocket headers in 'Header: value' format",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the summary as JSON for machine processing",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log verbosity level",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    payload = args.payload
    if payload:
        try:
            json.loads(payload)
        except json.JSONDecodeError:
            logger.warning("payload is not valid JSON; sending raw text")

    try:
        summary = asyncio.run(run_load_test(args))
    except KeyboardInterrupt:  # pragma: no cover - manual interruption
        logger.warning("interrupted by user")
        return 130

    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print("\n=== Load Test Summary ===")
        for key, value in summary.items():
            print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

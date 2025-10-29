"""TURN monitoring utilities for health checks and credential validation."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import logging
import os
import socket
import ssl
import struct
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence
from urllib.parse import parse_qs, urlparse

from app.config import get_settings
from app.monitoring import metrics


MAGIC_COOKIE = 0x2112A442
METHOD_ALLOCATE = 0x0003
CLASS_REQUEST = 0x0000
CLASS_SUCCESS_RESPONSE = 0x0100
CLASS_ERROR_RESPONSE = 0x0110

ATTR_ERROR_CODE = 0x0009
ATTR_USERNAME = 0x0006
ATTR_REALM = 0x0014
ATTR_NONCE = 0x0015
ATTR_MESSAGE_INTEGRITY = 0x0008
ATTR_LIFETIME = 0x000D
ATTR_REQUESTED_TRANSPORT = 0x0019

TRANSPORT_UDP = "udp"
TRANSPORT_TCP = "tcp"
TRANSPORT_TLS = "tls"


class TurnCheckError(RuntimeError):
    """Base class for health check errors with metric annotations."""

    category = "unknown"
    reachable = True

    def __init__(self, message: str, *, reachable: bool | None = None) -> None:
        super().__init__(message)
        if reachable is not None:
            self.reachable = reachable


class TurnConnectionError(TurnCheckError):
    category = "connect"

    def __init__(self, message: str) -> None:
        super().__init__(message, reachable=False)


class TurnAuthenticationError(TurnCheckError):
    category = "auth"


class TurnProtocolError(TurnCheckError):
    category = "protocol"


class TurnConfigurationError(TurnCheckError):
    category = "config"


@dataclass(slots=True)
class TurnEndpoint:
    """Represents a TURN endpoint that should be probed."""

    server_label: str
    host: str
    port: int
    transport: str
    secure: bool
    username: str | None
    credential: str | None


@dataclass(slots=True)
class TurnCheckResult:
    """Outcome of an individual TURN probe."""

    server_label: str
    host: str
    port: int
    transport: str
    reachable: bool
    auth_valid: bool
    category: str | None
    detail: str | None
    duration: float


@dataclass(slots=True)
class ParsedTurnURL:
    host: str
    port: int | None
    transport: str
    secure: bool


def _split_host_port(value: str) -> tuple[str, int | None]:
    if not value:
        return value, None
    if value.startswith("["):
        end = value.find("]")
        if end == -1:
            return value, None
        host = value[1:end]
        remainder = value[end + 1 :]
        if remainder.startswith(":"):
            try:
                return host, int(remainder[1:])
            except ValueError:
                return host, None
        return host, None
    if value.count(":") == 1:
        host, port = value.split(":", 1)
        try:
            return host, int(port)
        except ValueError:
            return value, None
    return value, None


def _parse_turn_url(url: str) -> ParsedTurnURL | None:
    parsed = urlparse(url)
    scheme = parsed.scheme or "turn"
    if scheme not in {"turn", "turns"}:
        return None
    raw_host = parsed.netloc or parsed.path
    if raw_host.startswith("//"):
        raw_host = raw_host[2:]
    host, port = _split_host_port(raw_host)
    transport = None
    query = parse_qs(parsed.query)
    if "transport" in query:
        candidate = query["transport"][0].lower()
        if candidate in {TRANSPORT_UDP, TRANSPORT_TCP, TRANSPORT_TLS}:
            transport = candidate
    secure = scheme == "turns" or transport == TRANSPORT_TLS
    if transport is None:
        transport = TRANSPORT_TLS if secure else TRANSPORT_UDP
    return ParsedTurnURL(host=host, port=port, transport=transport, secure=secure)


def _pad_attribute(value: bytes) -> bytes:
    padding = (4 - (len(value) % 4)) % 4
    return value + (b"\x00" * padding)


def _build_allocate_request(
    transaction_id: bytes,
    *,
    username: str | None = None,
    realm: str | None = None,
    nonce: str | None = None,
    password: str | None = None,
    lifetime: int = 600,
    requested_transport: int = 17,
) -> bytes:
    attributes: list[bytes] = []

    lifetime_value = struct.pack("!I", lifetime)
    attributes.append(struct.pack("!HH", ATTR_LIFETIME, len(lifetime_value)) + _pad_attribute(lifetime_value))

    transport_value = struct.pack("!B3x", requested_transport)
    attributes.append(
        struct.pack("!HH", ATTR_REQUESTED_TRANSPORT, len(transport_value)) + _pad_attribute(transport_value)
    )

    include_integrity = False
    if username is not None:
        username_bytes = username.encode("utf-8")
        attributes.append(
            struct.pack("!HH", ATTR_USERNAME, len(username_bytes)) + _pad_attribute(username_bytes)
        )
    if realm is not None:
        realm_bytes = realm.encode("utf-8")
        attributes.append(struct.pack("!HH", ATTR_REALM, len(realm_bytes)) + _pad_attribute(realm_bytes))
    if nonce is not None:
        nonce_bytes = nonce.encode("utf-8")
        attributes.append(struct.pack("!HH", ATTR_NONCE, len(nonce_bytes)) + _pad_attribute(nonce_bytes))
    if username and realm and nonce and password:
        include_integrity = True

    body = b"".join(attributes)
    message_type = METHOD_ALLOCATE | CLASS_REQUEST

    if include_integrity:
        mi_header = struct.pack("!HH", ATTR_MESSAGE_INTEGRITY, 20)
        header = struct.pack(
            "!HHI12s",
            message_type,
            len(body) + len(mi_header) + 20,
            MAGIC_COOKIE,
            transaction_id,
        )
        placeholder = header + body + mi_header + (b"\x00" * 20)
        key = hashlib.md5(f"{username}:{realm}:{password}".encode("utf-8")).digest()
        digest = hmac.new(key, placeholder, hashlib.sha1).digest()
        return header + body + mi_header + digest

    header = struct.pack("!HHI12s", message_type, len(body), MAGIC_COOKIE, transaction_id)
    return header + body


def _decode_stun_message(data: bytes) -> tuple[int, bytes, dict[int, list[bytes]]]:
    if len(data) < 20:
        raise TurnProtocolError("TURN server returned an incomplete response")
    msg_type, length, cookie, transaction_id = struct.unpack("!HHI12s", data[:20])
    if cookie != MAGIC_COOKIE:
        raise TurnProtocolError("Invalid STUN magic cookie in response")
    if len(data) < 20 + length:
        raise TurnProtocolError("TURN response truncated before all attributes were received")
    attributes: dict[int, list[bytes]] = {}
    position = 20
    end = 20 + length
    while position + 4 <= end:
        attr_type, attr_length = struct.unpack("!HH", data[position : position + 4])
        position += 4
        value = data[position : position + attr_length]
        position += attr_length
        if attr_length % 4:
            position += 4 - (attr_length % 4)
        attributes.setdefault(attr_type, []).append(value)
    return msg_type, transaction_id, attributes


def _parse_error_attribute(value: bytes) -> tuple[int, str]:
    if len(value) < 4:
        raise TurnProtocolError("Malformed TURN error attribute")
    code = (value[2] & 0x07) * 100 + value[3]
    reason = value[4:].decode("utf-8", errors="ignore").strip()
    return code, reason


def _extract_attr_text(attributes: dict[int, list[bytes]], attr_type: int) -> str:
    values = attributes.get(attr_type)
    if not values:
        return ""
    return values[-1].decode("utf-8", errors="ignore")


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    buffer = bytearray()
    while len(buffer) < size:
        chunk = sock.recv(size - len(buffer))
        if not chunk:
            raise TurnConnectionError("Connection closed while receiving TURN response")
        buffer.extend(chunk)
    return bytes(buffer)


def _send_recv_udp(sock: socket.socket, endpoint: TurnEndpoint, payload: bytes) -> bytes:
    sock.sendto(payload, (endpoint.host, endpoint.port))
    return sock.recv(4096)


def _send_recv_stream(sock: socket.socket, payload: bytes) -> bytes:
    sock.sendall(payload)
    header = _recv_exact(sock, 20)
    length = struct.unpack("!H", header[2:4])[0]
    body = _recv_exact(sock, length)
    return header + body


def _perform_allocate(endpoint: TurnEndpoint, timeout: float) -> None:
    transport = endpoint.transport
    try:
        if transport == TRANSPORT_UDP:
            udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            udp_socket.settimeout(timeout)
            with udp_socket:
                _execute_allocate(endpoint, lambda payload: _send_recv_udp(udp_socket, endpoint, payload))
        else:
            raw_sock = socket.create_connection((endpoint.host, endpoint.port), timeout=timeout)
            raw_sock.settimeout(timeout)
            sock_obj: socket.socket
            if transport == TRANSPORT_TLS or endpoint.secure:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                sock_obj = context.wrap_socket(raw_sock, server_hostname=endpoint.host)
            else:
                sock_obj = raw_sock
            with sock_obj:
                sock_obj.settimeout(timeout)
                _execute_allocate(endpoint, lambda payload: _send_recv_stream(sock_obj, payload))
    except socket.timeout as exc:
        raise TurnConnectionError(
            f"TURN endpoint {endpoint.host}:{endpoint.port} timed out"
        ) from exc
    except (ConnectionError, OSError, ssl.SSLError) as exc:
        raise TurnConnectionError(
            f"Unable to connect to TURN endpoint {endpoint.host}:{endpoint.port}: {exc}"
        ) from exc


def _execute_allocate(endpoint: TurnEndpoint, sender: Callable[[bytes], bytes]) -> None:
    transaction_id = os.urandom(12)
    initial = _build_allocate_request(transaction_id)
    response = sender(initial)
    msg_type, resp_transaction, attributes = _decode_stun_message(response)
    if resp_transaction != transaction_id:
        raise TurnProtocolError("TURN server returned mismatched transaction ID")

    error_values = attributes.get(ATTR_ERROR_CODE)
    if not error_values:
        if (msg_type & (CLASS_SUCCESS_RESPONSE | CLASS_ERROR_RESPONSE)) != CLASS_SUCCESS_RESPONSE:
            raise TurnProtocolError("Unexpected TURN response class during unauthenticated allocate")
        return

    code, reason = _parse_error_attribute(error_values[-1])
    if code not in (401, 438):
        raise TurnAuthenticationError(f"TURN server rejected unauthenticated allocate ({code} {reason})")

    realm = _extract_attr_text(attributes, ATTR_REALM)
    nonce = _extract_attr_text(attributes, ATTR_NONCE)
    if not realm or not nonce:
        raise TurnProtocolError("TURN server did not supply realm/nonce for authentication challenge")

    if not endpoint.username or not endpoint.credential:
        raise TurnConfigurationError(
            f"Credentials missing for TURN server '{endpoint.server_label}'"
        )

    attempts = 0
    current_nonce = nonce
    while attempts < 2:
        attempts += 1
        auth_transaction = os.urandom(12)
        authenticated_request = _build_allocate_request(
            auth_transaction,
            username=endpoint.username,
            realm=realm,
            nonce=current_nonce,
            password=endpoint.credential,
        )
        response = sender(authenticated_request)
        msg_type, resp_tid, attributes = _decode_stun_message(response)
        if resp_tid != auth_transaction:
            raise TurnProtocolError("TURN server returned mismatched transaction ID during authentication")

        error_values = attributes.get(ATTR_ERROR_CODE)
        if not error_values:
            if (msg_type & (CLASS_SUCCESS_RESPONSE | CLASS_ERROR_RESPONSE)) != CLASS_SUCCESS_RESPONSE:
                raise TurnProtocolError("TURN server returned unexpected response class after authentication")
            return

        code, reason = _parse_error_attribute(error_values[-1])
        if code == 438 and ATTR_NONCE in attributes and attempts < 2:
            current_nonce = _extract_attr_text(attributes, ATTR_NONCE)
            continue
        raise TurnAuthenticationError(f"TURN authentication failed ({code} {reason})")

    raise TurnAuthenticationError("TURN server repeatedly returned stale nonce responses")


class TurnHealthMonitor:
    """Runs TURN health probes and updates metrics."""

    def __init__(self, *, timeout: float = 3.0, extra_urls: Sequence[str] | None = None) -> None:
        self.timeout = timeout
        self.extra_urls = list(extra_urls or [])
        self.logger = logging.getLogger("turn_health")
        metrics.mark_initial_state()

    def run_once(self) -> list[TurnCheckResult]:
        settings = get_settings()
        endpoints = self._build_endpoints(settings)
        if not endpoints:
            self.logger.warning("No TURN servers configured for monitoring")
            return []

        results: list[TurnCheckResult] = []
        start_time = time.perf_counter()
        for endpoint in endpoints:
            results.append(self._probe_endpoint(endpoint))
        duration = time.perf_counter() - start_time

        metrics.turn_health_duration_seconds.set(duration)
        metrics.turn_health_last_run_timestamp.set(time.time())

        self._log_summary(results, duration)
        return results

    def run_forever(self, *, interval: int) -> None:
        if interval <= 0:
            raise ValueError("Interval must be a positive integer for continuous monitoring")
        try:
            while True:
                self.run_once()
                time.sleep(interval)
        except KeyboardInterrupt:
            self.logger.info("TURN health monitor interrupted; exiting")

    def _probe_endpoint(self, endpoint: TurnEndpoint) -> TurnCheckResult:
        self.logger.debug(
            "Probing TURN endpoint %s (%s:%d via %s)",
            endpoint.server_label,
            endpoint.host,
            endpoint.port,
            endpoint.transport,
        )
        start = time.perf_counter()
        try:
            _perform_allocate(endpoint, self.timeout)
        except TurnCheckError as exc:
            duration = time.perf_counter() - start
            reachable = bool(getattr(exc, "reachable", True))
            result = TurnCheckResult(
                server_label=endpoint.server_label,
                host=endpoint.host,
                port=endpoint.port,
                transport=endpoint.transport,
                reachable=reachable,
                auth_valid=False,
                category=exc.category,
                detail=str(exc),
                duration=duration,
            )
            self._record_metrics(result)
            level = logging.WARNING if reachable else logging.ERROR
            self.logger.log(
                level,
                "TURN probe failed for %s (%s:%d %s): %s",
                endpoint.server_label,
                endpoint.host,
                endpoint.port,
                endpoint.transport,
                exc,
            )
            return result
        except Exception as exc:
            duration = time.perf_counter() - start
            self.logger.exception(
                "Unexpected error during TURN probe for %s (%s:%d %s)",
                endpoint.server_label,
                endpoint.host,
                endpoint.port,
                endpoint.transport,
            )
            result = TurnCheckResult(
                server_label=endpoint.server_label,
                host=endpoint.host,
                port=endpoint.port,
                transport=endpoint.transport,
                reachable=False,
                auth_valid=False,
                category="unexpected",
                detail=str(exc),
                duration=duration,
            )
            self._record_metrics(result)
            return result

        duration = time.perf_counter() - start
        result = TurnCheckResult(
            server_label=endpoint.server_label,
            host=endpoint.host,
            port=endpoint.port,
            transport=endpoint.transport,
            reachable=True,
            auth_valid=True,
            category=None,
            detail=None,
            duration=duration,
        )
        self._record_metrics(result)
        return result

    def _record_metrics(self, result: TurnCheckResult) -> None:
        metrics.turn_port_availability.set(
            1 if result.reachable else 0,
            server=result.server_label,
            port=str(result.port),
            transport=result.transport,
        )
        if result.auth_valid:
            metrics.turn_auth_success_total.inc(server=result.server_label, transport=result.transport)
        else:
            category = result.category or "unknown"
            metrics.turn_auth_failure_total.inc(
                server=result.server_label,
                transport=result.transport,
                category=category,
            )

    def _log_summary(self, results: Sequence[TurnCheckResult], duration: float) -> None:
        success = sum(1 for item in results if item.auth_valid)
        failure = len(results) - success
        self.logger.info(
            "TURN health run completed in %.2fs (%d success, %d failure)",
            duration,
            success,
            failure,
        )
        for item in results:
            if item.auth_valid:
                self.logger.info(
                    "  ✅ %s:%d (%s) %s",
                    item.host,
                    item.port,
                    item.transport,
                    item.server_label,
                )
            else:
                self.logger.error(
                    "  ❌ %s:%d (%s) %s [%s]%s",
                    item.host,
                    item.port,
                    item.transport,
                    item.server_label,
                    item.category or "unknown",
                    f" {item.detail}" if item.detail else "",
                )

    def _build_endpoints(self, settings) -> list[TurnEndpoint]:
        entries: list[tuple[str, str | None, str | None]] = []

        def add_entries(urls: Iterable[str], username: str | None, credential: str | None) -> None:
            for url in urls:
                entries.append((str(url), username, credential))

        base_username = settings.webrtc_turn_username
        base_credential = settings.webrtc_turn_credential

        add_entries(settings.webrtc_turn_servers, base_username, base_credential)
        for server in settings.webrtc_turn_fallback_servers:
            add_entries(server.urls, server.username or base_username, server.credential or base_credential)

        if self.extra_urls:
            add_entries(self.extra_urls, base_username, base_credential)

        endpoints: dict[tuple[str, str, int, str], TurnEndpoint] = {}

        for url, username, credential in entries:
            parsed = _parse_turn_url(url)
            if parsed is None or not parsed.host:
                continue
            label = url

            for port, transport, secure in ((3478, TRANSPORT_UDP, False), (5349, TRANSPORT_TLS, True)):
                key = (label, parsed.host, port, transport)
                endpoints.setdefault(
                    key,
                    TurnEndpoint(
                        server_label=label,
                        host=parsed.host,
                        port=port,
                        transport=transport,
                        secure=secure,
                        username=username,
                        credential=credential,
                    ),
                )

            if parsed.port is not None:
                key = (label, parsed.host, parsed.port, parsed.transport)
                endpoints.setdefault(
                    key,
                    TurnEndpoint(
                        server_label=label,
                        host=parsed.host,
                        port=parsed.port,
                        transport=parsed.transport,
                        secure=parsed.secure,
                        username=username,
                        credential=credential,
                    ),
                )

        return list(endpoints.values())


def _create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe TURN servers for port reachability and credential validity.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=0,
        help="Continuous mode interval in seconds. If omitted, the probe runs once.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=3.0,
        help="Socket timeout in seconds for TURN requests.",
    )
    parser.add_argument(
        "--turn-url",
        action="append",
        dest="extra_urls",
        default=[],
        help="Additional TURN URLs to probe in addition to the configured ones.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging verbosity (DEBUG, INFO, WARNING, ERROR).",
    )
    return parser


def main() -> None:
    parser = _create_argument_parser()
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    monitor = TurnHealthMonitor(timeout=args.timeout, extra_urls=args.extra_urls)
    if args.interval > 0:
        monitor.run_forever(interval=args.interval)
    else:
        monitor.run_once()


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    main()

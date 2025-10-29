"""Metric definitions for TURN monitoring and system health."""

from __future__ import annotations

import time

from .registry import registry


turn_auth_success_total = registry.counter(
    "turn_auth_success_total",
    "Number of successful TURN authentication validation probes.",
    label_names=("server", "transport"),
)

turn_auth_failure_total = registry.counter(
    "turn_auth_failure_total",
    "Number of failed TURN authentication validation probes.",
    label_names=("server", "transport", "category"),
)

turn_port_availability = registry.gauge(
    "turn_port_availability",
    "Availability of TURN listener ports (1=reachable, 0=offline).",
    label_names=("server", "port", "transport"),
)

turn_health_duration_seconds = registry.gauge(
    "turn_health_duration_seconds",
    "Execution time of the most recent TURN health probe run.",
)

turn_health_last_run_timestamp = registry.gauge(
    "turn_health_last_run_timestamp",
    "Unix timestamp of the last TURN health probe run.",
)


def mark_initial_state() -> None:
    """Expose a baseline timestamp for environments that scrape before the first probe."""

    turn_health_last_run_timestamp.set(time.time())
    turn_health_duration_seconds.set(0)


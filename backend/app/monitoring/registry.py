"""Lightweight metrics registry for Prometheus compatible exports."""

from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Mapping, Sequence


def _format_value(value: float) -> str:
    """Format floating point values using Prometheus conventions."""

    return f"{value:.6f}".rstrip("0").rstrip(".") if not value.is_integer() else str(int(value))


def _format_labels(names: Sequence[str], values: Sequence[str]) -> str:
    if not names:
        return ""

    pairs = []
    for name, value in zip(names, values, strict=False):
        escaped = (
            value.replace("\\", r"\\\\")
            .replace("\n", r"\\n")
            .replace('"', r"\\\"")
        )
        pairs.append(f'{name}="{escaped}"')
    return "{" + ",".join(pairs) + "}"


class MetricsRegistry:
    """In-memory registry that collects metric samples."""

    def __init__(self) -> None:
        self._metrics: dict[str, _MetricBase] = {}
        self._lock = Lock()

    def register(self, metric: "_MetricBase") -> None:
        with self._lock:
            if metric.name in self._metrics:
                raise ValueError(f"Metric '{metric.name}' already registered")
            self._metrics[metric.name] = metric

    def counter(self, name: str, description: str, *, label_names: Sequence[str] = ()) -> "CounterMetric":
        metric = CounterMetric(name=name, description=description, label_names=tuple(label_names))
        self.register(metric)
        return metric

    def gauge(self, name: str, description: str, *, label_names: Sequence[str] = ()) -> "GaugeMetric":
        metric = GaugeMetric(name=name, description=description, label_names=tuple(label_names))
        self.register(metric)
        return metric

    def render(self) -> str:
        """Render all registered metrics using the Prometheus text format."""

        lines: list[str] = []
        for name in sorted(self._metrics):
            metric = self._metrics[name]
            lines.extend(metric.render())
        return "\n".join(lines) + "\n"


@dataclass(slots=True)
class _MetricSample:
    labels: tuple[str, ...]
    value: float


class _MetricBase:
    """Shared base for metric implementations."""

    metric_type: str = "untyped"

    def __init__(self, *, name: str, description: str, label_names: Sequence[str]) -> None:
        self.name = name
        self.description = description
        self.label_names = tuple(label_names)
        self._samples: dict[tuple[str, ...], float] = {}
        self._lock = Lock()

    # Methods expected to be implemented by subclasses.
    def _update(self, amount: float, labels: tuple[str, ...]) -> None:
        raise NotImplementedError

    def render(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.description}", f"# TYPE {self.name} {self.metric_type}"]
        with self._lock:
            samples = [
                _MetricSample(labels=labels, value=value)
                for labels, value in self._samples.items()
            ]

        if not samples:
            # Prometheus expects at least one sample; expose zero value without labels.
            lines.append(f"{self.name} 0")
            return lines

        samples.sort(key=lambda sample: sample.labels)
        for sample in samples:
            label_block = _format_labels(self.label_names, sample.labels)
            lines.append(f"{self.name}{label_block} {_format_value(sample.value)}")
        return lines

    def _normalize_labels(self, provided: Mapping[str, object]) -> tuple[str, ...]:
        if set(provided) != set(self.label_names):
            expected = ", ".join(self.label_names) or "<none>"
            received = ", ".join(sorted(provided)) or "<none>"
            raise ValueError(
                f"Metric '{self.name}' expected labels [{expected}] but received [{received}]"
            )
        return tuple(str(provided[label]) for label in self.label_names)


class CounterMetric(_MetricBase):
    metric_type = "counter"

    def inc(self, *, amount: float = 1.0, **labels: object) -> None:
        if amount < 0:
            raise ValueError("Counters cannot be incremented by negative values")
        label_values = self._normalize_labels(labels)
        self._update(amount, label_values)

    def _update(self, amount: float, labels: tuple[str, ...]) -> None:  # noqa: D401 - internal API
        with self._lock:
            self._samples[labels] = self._samples.get(labels, 0.0) + amount


class GaugeMetric(_MetricBase):
    metric_type = "gauge"

    def set(self, value: float, **labels: object) -> None:
        label_values = self._normalize_labels(labels)
        with self._lock:
            self._samples[label_values] = float(value)


# Shared registry instance used across the backend.
registry = MetricsRegistry()


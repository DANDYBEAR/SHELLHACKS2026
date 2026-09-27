"""Shared opportunity scoring helpers for local DB builders.

The frontend mirrors these point bands in shared/analysis.ts. Keep the
implementation deterministic so generated SQLite rankings and API rankings
agree during demos.
"""
from __future__ import annotations

import math

MAX_COMPARISON_DISTANCE_MI = 25


def _ranged_score(value: float, start: float, end: float, high: int, low: int) -> int:
    ratio = (value - start) / (end - start)
    clipped = max(0.0, min(1.0, ratio))
    return round(high - clipped * (high - low))


def distance_points(distance_mi: float) -> int:
    if not math.isfinite(distance_mi) or distance_mi < 0 or distance_mi > MAX_COMPARISON_DISTANCE_MI:
        return 0
    if distance_mi <= 2:
        return 40
    if distance_mi <= 5:
        return _ranged_score(distance_mi, 2, 5, 39, 36)
    if distance_mi <= 10:
        return _ranged_score(distance_mi, 5, 10, 35, 30)
    if distance_mi <= 15:
        return _ranged_score(distance_mi, 10, 15, 29, 22)
    if distance_mi <= 20:
        return _ranged_score(distance_mi, 15, 20, 21, 14)
    return _ranged_score(distance_mi, 20, 25, 13, 5)


def timeline_points(day_gap: int | None) -> int:
    """Score date proximity until construction-window overlap is available.

    Current imported rows generally have planned in-service dates, not start/end
    construction windows. That means a same-day pair is scored in the
    "no overlap, <=1 month apart" band. Once real construction windows are
    parsed, overlap duration can award the 30-40 point overlap bands.
    """
    if day_gap is None or not math.isfinite(day_gap) or day_gap < 0:
        return 0
    if day_gap <= 30:
        return _ranged_score(day_gap, 0, 30, 29, 24)
    if day_gap <= 90:
        return _ranged_score(day_gap, 31, 90, 23, 18)
    if day_gap <= 180:
        return _ranged_score(day_gap, 91, 180, 17, 10)
    if day_gap <= 365:
        return _ranged_score(day_gap, 181, 365, 9, 3)
    if day_gap <= 730:
        return _ranged_score(day_gap, 366, 730, 2, 0)
    return 0


def compatibility_points(value: float | int | None = None) -> int:
    if value is None or not math.isfinite(value):
        return 0
    return max(0, min(20, round(value)))


def opportunity_points(distance_mi: float, day_gap: int | None, compatibility: float | int | None = None) -> tuple[int, int, int, int]:
    distance = distance_points(distance_mi)
    timeline = timeline_points(day_gap)
    compatible = compatibility_points(compatibility)
    return distance, timeline, compatible, distance + timeline + compatible

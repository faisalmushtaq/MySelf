from statistics import median

SPEED_THRESHOLD = 15.0
LENGTH_THRESHOLD = 250
RATIO_THRESHOLD = 0.3


def median_instant_typing_speed(trace):
    """Return median positive typing speed in characters per second."""
    if not isinstance(trace, list) or not trace:
        return 0.0

    if len(trace) == 1:
        only_len = trace[0].get("len") if isinstance(trace[0], dict) else None
        if isinstance(only_len, (int, float)) and only_len > 1:
            return float("inf")
        return 0.0

    speeds = []
    previous = trace[0]
    for current in trace[1:]:
        if not isinstance(previous, dict) or not isinstance(current, dict):
            previous = current
            continue

        previous_t = previous.get("t_ms")
        current_t = current.get("t_ms")
        previous_len = previous.get("len")
        current_len = current.get("len")

        if not all(
            isinstance(value, (int, float))
            for value in [previous_t, current_t, previous_len, current_len]
        ):
            previous = current
            continue

        delta_ms = current_t - previous_t
        delta_len = current_len - previous_len
        if delta_ms > 0 and delta_len > 0:
            speeds.append(delta_len / (delta_ms / 1000.0))

        previous = current

    return float(median(speeds)) if speeds else 0.0


def build_message_trace(input_data, message_index):
    """Create one saved quality trace entry for a submitted human message."""
    message = input_data.get("message", "")
    typing_speed = median_instant_typing_speed(input_data.get("typingTrace", []))

    return {
        "message_index": message_index,
        "is_pasted": bool(input_data.get("isPasted", False)),
        "median_typing_speed": typing_speed,
        "fast_typing_anomaly": typing_speed > SPEED_THRESHOLD,
        "long_or_multiline_human_message": (
            len(message) > LENGTH_THRESHOLD or "\n" in message or "\\n" in message
        ),
    }


def compute_quality_control(quality_tracing):
    """Aggregate message-level quality traces into review ratios."""
    if not isinstance(quality_tracing, list) or not quality_tracing:
        return {
            "message_count": 0,
            "paste_message_ratio": 0.0,
            "fast_typing_anomaly_ratio": 0.0,
            "long_or_multiline_human_message_ratio": 0.0,
            "ratio_threshold": RATIO_THRESHOLD,
            "speed_threshold": SPEED_THRESHOLD,
            "length_threshold": LENGTH_THRESHOLD,
        }

    total = len(quality_tracing)
    pasted = sum(1 for item in quality_tracing if item.get("is_pasted"))
    fast = sum(1 for item in quality_tracing if item.get("fast_typing_anomaly"))
    long_or_multiline = sum(
        1 for item in quality_tracing if item.get("long_or_multiline_human_message")
    )

    return {
        "message_count": total,
        "paste_message_ratio": pasted / total,
        "fast_typing_anomaly_ratio": fast / total,
        "long_or_multiline_human_message_ratio": long_or_multiline / total,
        "ratio_threshold": RATIO_THRESHOLD,
        "speed_threshold": SPEED_THRESHOLD,
        "length_threshold": LENGTH_THRESHOLD,
    }


def is_flagged_for_review(quality_control):
    """Return True when any aggregate quality metric exceeds the review threshold."""
    threshold = quality_control.get("ratio_threshold", RATIO_THRESHOLD)
    return any(
        quality_control.get(metric, 0.0) > threshold
        for metric in [
            "paste_message_ratio",
            "fast_typing_anomaly_ratio",
            "long_or_multiline_human_message_ratio",
        ]
    )

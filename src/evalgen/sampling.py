"""
Ranks ungraded outputs using assertion selectivity and alternating high/low confidence

The paper's confidence equation and its stated pass/fail polarity disagree. Following
its prose, confidence sums pass rates of assertions that explicitly fail an output:
failure by a usually-passing assertion is stronger evidence of a problematic output.
"""

from collections.abc import Sequence
from dataclasses import dataclass

Verdict = bool | None
Grade = bool | None


@dataclass(frozen=True)
class SamplingPlan:
    selectivities: list[list[float | None]]
    confidence: list[float]
    known_counts: list[int]
    next_index: int | None
    next_high: bool


def sampling_plan(
    results: Sequence[Sequence[Sequence[Verdict]]],
    grades: Sequence[Grade],
    next_high: bool = True,
) -> SamplingPlan:
    """
    Suggests the highest- or lowest-confidence ungraded output, with stable index ties

    Selectivity is the pass rate among a candidate's known verdicts, None with no known
    verdicts. Unknown outcomes do not contribute passes or failures. Confidence is zero
    without evidence; known_counts reports the number of observed verdicts per output.

    next_high is returned unchanged. The caller owns alternation state and flips it only
    when a new grade is consumed, so polling partial results never advances the policy.

    Raises:
        ValueError: A candidate does not have one verdict per output.
    """
    size = len(grades)
    selectivities: list[list[float | None]] = []
    confidence = [0.0] * size
    known_counts = [0] * size
    for group in results:
        group_selectivities = []
        for verdicts in group:
            if len(verdicts) != size:
                raise ValueError("Every candidate must have one verdict per output")
            known = sum(verdict is not None for verdict in verdicts)
            selectivity = sum(verdict is True for verdict in verdicts) / known if known else None
            group_selectivities.append(selectivity)
            for index, verdict in enumerate(verdicts):
                known_counts[index] += verdict is not None
                if verdict is False and selectivity is not None:
                    confidence[index] += selectivity
        selectivities.append(group_selectivities)

    ungraded = [index for index, grade in enumerate(grades) if grade is None]
    choose = max if next_high else min
    next_index = choose(ungraded, key=confidence.__getitem__) if ungraded else None
    return SamplingPlan(selectivities, confidence, known_counts, next_index, next_high)

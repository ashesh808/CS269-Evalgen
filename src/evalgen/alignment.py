"""
Scores assertions against human grades and picks the most aligned one per criterion

Coverage, false failure rate and alignment follow section 4.2 of Shankar et al. (UIST 2024)
A verdict of None never counts as a failure, as the grader produced no evidence either way
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

Verdict = bool | None
Grade = bool | None


@dataclass(frozen=True)
class Confusion:
    bad_failed: int = 0
    bad_passed: int = 0
    good_failed: int = 0
    good_passed: int = 0


@dataclass(frozen=True)
class Score:
    coverage: float | None
    ffr: float | None
    alignment: float | None
    confusion: Confusion = field(default_factory=Confusion)


@dataclass(frozen=True)
class CriterionReport:
    scores: list[Score]
    selected: int | None


@dataclass(frozen=True)
class Report:
    criteria: list[CriterionReport]
    overall: Score
    set_fails: list[bool]


def score(fails: Sequence[bool], grades: Sequence[Grade]) -> Score:
    """
    Computes coverage, false failure rate and alignment of one failure pattern

    Coverage is the share of bad outputs flagged, FFR the share of good outputs flagged
    Alignment is the harmonic mean of coverage and 1 - FFR

    Args:
        fails: Whether the assertion or set flags each output.
        grades: The human grade per output, True for good, None for ungraded.

    Returns:
        The score, with None for any rate whose denominator is empty.
    """
    bad = [fail for fail, grade in zip(fails, grades, strict=True) if grade is False]
    good = [fail for fail, grade in zip(fails, grades, strict=True) if grade is True]
    confusion = Confusion(
        bad_failed=sum(bad),
        bad_passed=len(bad) - sum(bad),
        good_failed=sum(good),
        good_passed=len(good) - sum(good),
    )
    coverage = sum(bad) / len(bad) if bad else None
    ffr = sum(good) / len(good) if good else None
    if coverage is None or ffr is None:
        return Score(coverage, ffr, None, confusion)
    passed = 1 - ffr
    total = coverage + passed
    alignment = 2 * coverage * passed / total if total else 0.0
    return Score(coverage, ffr, alignment, confusion)


def failures(verdicts: Sequence[Verdict]) -> list[bool]:
    """
    Turns verdicts into failure flags

    Args:
        verdicts: One verdict per output.

    Returns:
        True where the verdict is an explicit fail.
    """
    return [verdict is False for verdict in verdicts]


def select(scores: Sequence[Score], ffr_threshold: float) -> int | None:
    """
    Picks the candidate with the highest alignment among those under the FFR threshold

    Ties break toward the lower FFR, then the higher coverage, then the earlier candidate

    Args:
        scores: One score per candidate assertion.
        ffr_threshold: The largest false failure rate a selected assertion may have.

    Returns:
        The index of the selected candidate, None when no candidate qualifies or nothing is graded.
    """
    eligible = [
        index
        for index, item in enumerate(scores)
        if (item.coverage is not None or item.ffr is not None)
        and (item.ffr is None or item.ffr <= ffr_threshold)
    ]
    if not eligible:
        return None

    def rank(index: int) -> tuple[float, float, float]:
        item = scores[index]
        alignment = -1.0 if item.alignment is None else item.alignment
        ffr = 0.0 if item.ffr is None else item.ffr
        coverage = 0.0 if item.coverage is None else item.coverage
        return (alignment, -ffr, coverage)

    return max(eligible, key=rank)


def build_report(
    results: Sequence[Sequence[Sequence[Verdict]]],
    grades: Sequence[Grade],
    ffr_threshold: float,
    active: Sequence[bool] | None = None,
) -> Report:
    """
    Scores every candidate, selects one per criterion, and scores the selected set

    An output fails the set when any selected assertion fails it

    Args:
        results: Verdicts indexed as [criterion][assertion][output].
        grades: The human grade per output, True for good, None for ungraded.
        ffr_threshold: The largest false failure rate a selected assertion may have.
        active: Which criteria join the set score, all of them when None.

    Returns:
        Per-criterion scores and selections, plus the selected set's score and failures.
    """
    reports = []
    set_fails = [False] * len(grades)
    active = [True] * len(results) if active is None else active
    for group, included in zip(results, active, strict=True):
        flags = [failures(verdicts) for verdicts in group]
        scores = [score(flag, grades) for flag in flags]
        selected = select(scores, ffr_threshold)
        if selected is not None and included:
            set_fails = [a or b for a, b in zip(set_fails, flags[selected], strict=True)]
        reports.append(CriterionReport(scores, selected))
    return Report(reports, score(set_fails, grades), set_fails)

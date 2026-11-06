"""
Scores assertions against human grades and picks the most aligned one per criterion

Coverage, false failure rate and alignment follow section 4.2 of Shankar et al. (UIST 2024)
Unreadable verdicts remain unknown and cannot qualify a candidate for selection
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
    bad_unknown: int = 0
    good_unknown: int = 0


@dataclass(frozen=True)
class Score:
    coverage: float | None
    ffr: float | None
    alignment: float | None
    confusion: Confusion = field(default_factory=Confusion)
    complete: bool = True
    known_count: int = 0
    unknown_count: int = 0


@dataclass(frozen=True)
class CriterionReport:
    scores: list[Score]
    selected: int | None


@dataclass(frozen=True)
class Report:
    criteria: list[CriterionReport]
    overall: Score
    set_fails: list[bool | None]
    active_count: int = 0
    selected_count: int = 0
    selection_complete: bool = False


def score(fails: Sequence[bool | None], grades: Sequence[Grade]) -> Score:
    """
    Computes coverage, false failure rate and alignment of one failure pattern

    Coverage is the share of bad outputs flagged, FFR the share of good outputs flagged
    Alignment is the harmonic mean of coverage and 1 - FFR

    Args:
        fails: Whether the assertion or set flags each output, None when unknown.
        grades: The human grade per output, True for good, None for ungraded.

    Returns:
        The score, with None for a rate with no grades or an unknown outcome in that class.
        Counts cover all outputs, including ungraded outputs, so completeness can gate selection.
    """
    if len(fails) != len(grades):
        raise ValueError("Each output must have one failure flag and one grade")
    bad = [fail for fail, grade in zip(fails, grades, strict=True) if grade is False]
    good = [fail for fail, grade in zip(fails, grades, strict=True) if grade is True]
    confusion = Confusion(
        bad_failed=sum(fail is True for fail in bad),
        bad_passed=sum(fail is False for fail in bad),
        good_failed=sum(fail is True for fail in good),
        good_passed=sum(fail is False for fail in good),
        bad_unknown=sum(fail is None for fail in bad),
        good_unknown=sum(fail is None for fail in good),
    )
    coverage = confusion.bad_failed / len(bad) if bad and not confusion.bad_unknown else None
    ffr = confusion.good_failed / len(good) if good and not confusion.good_unknown else None
    alignment = None
    if coverage is not None and ffr is not None:
        passed = 1 - ffr
        total = coverage + passed
        alignment = 2 * coverage * passed / total if total else 0.0
    unknown_count = sum(fail is None for fail in fails)
    return Score(
        coverage,
        ffr,
        alignment,
        confusion,
        complete=unknown_count == 0,
        known_count=len(fails) - unknown_count,
        unknown_count=unknown_count,
    )


def failures(verdicts: Sequence[Verdict]) -> list[bool | None]:
    """
    Turns verdicts into failure flags

    Args:
        verdicts: One verdict per output.

    Returns:
        True where the verdict is an explicit fail, None where no verdict is available.
    """
    return [None if verdict is None else verdict is False for verdict in verdicts]


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
    if not 0.0 <= ffr_threshold <= 1.0:
        raise ValueError("The false failure threshold must be between 0 and 1")
    eligible = [
        index
        for index, item in enumerate(scores)
        if item.complete
        and item.unknown_count == 0
        and (item.coverage is not None or item.ffr is not None)
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

    An output fails the set when any selected assertion fails it. An unresolved active
    criterion keeps other outcomes unknown; an empty selected set has no available outcomes.

    Args:
        results: Verdicts indexed as [criterion][assertion][output].
        grades: The human grade per output, True for good, None for ungraded.
        ffr_threshold: The largest false failure rate a selected assertion may have.
        active: Which criteria join the set score, all of them when None.

    Returns:
        Per-criterion scores and selections, plus the selected set's score and failures.
    """
    if not 0.0 <= ffr_threshold <= 1.0:
        raise ValueError("The false failure threshold must be between 0 and 1")
    active = [True] * len(results) if active is None else active
    if len(active) != len(results):
        raise ValueError("active must have one entry per criterion")
    for group in results:
        for verdicts in group:
            if len(verdicts) != len(grades):
                raise ValueError("Every candidate must have one verdict per output")

    reports = []
    included_flags: list[list[bool | None]] = []
    selected_count = 0
    for group, included in zip(results, active, strict=True):
        flags = [failures(verdicts) for verdicts in group]
        scores = [score(flag, grades) for flag in flags]
        selected = select(scores, ffr_threshold)
        if included:
            included_flags.append([None] * len(grades) if selected is None else flags[selected])
            selected_count += selected is not None
        reports.append(CriterionReport(scores, selected))
    set_fails: list[bool | None] = [None] * len(grades)
    if selected_count:
        for index in range(len(grades)):
            outcomes = [pattern[index] for pattern in included_flags]
            if any(outcome is True for outcome in outcomes):
                set_fails[index] = True
            elif all(outcome is False for outcome in outcomes):
                set_fails[index] = False
    active_count = sum(active)
    return Report(
        reports,
        score(set_fails, grades),
        set_fails,
        active_count=active_count,
        selected_count=selected_count,
        selection_complete=active_count > 0 and selected_count == active_count,
    )

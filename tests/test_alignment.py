import pytest

from evalgen.alignment import Confusion, Score, build_report, failures, score, select


def test_score_matches_paper_definitions() -> None:
    # Two bad outputs, one caught; two good outputs, one wrongly failed
    grades = [False, False, True, True]
    fails = [True, False, True, False]
    result = score(fails, grades)
    assert result.coverage == 0.5
    assert result.ffr == 0.5
    assert result.alignment == pytest.approx(0.5)


def test_score_ignores_ungraded_outputs() -> None:
    result = score([True, True], [False, None])
    assert (result.coverage, result.ffr, result.alignment) == (1.0, None, None)
    assert result.confusion == Confusion(bad_failed=1)


def test_score_zero_alignment_without_division_error() -> None:
    assert score([False, True], [False, True]).alignment == 0.0


def test_failures_treats_missing_verdict_as_pass() -> None:
    assert failures([True, False, None]) == [False, True, False]


def test_select_respects_threshold() -> None:
    aligned_but_noisy = Score(coverage=1.0, ffr=0.5, alignment=0.67)
    quiet = Score(coverage=0.5, ffr=0.0, alignment=0.67)
    lenient = Score(coverage=0.0, ffr=0.0, alignment=0.0)
    assert select([aligned_but_noisy, quiet, lenient], ffr_threshold=0.4) == 1
    assert select([aligned_but_noisy], ffr_threshold=0.4) is None


def test_select_needs_some_grade() -> None:
    assert select([Score(None, None, None)], ffr_threshold=1.0) is None


def test_build_report_unions_selected_failures() -> None:
    grades = [False, False, True]
    results = [
        [[False, True, True], [True, True, True]],  # first assertion catches output 0
        [[True, False, True]],  # catches output 1
    ]
    report = build_report(results, grades, ffr_threshold=0.0)
    assert [c.selected for c in report.criteria] == [0, 0]
    assert report.set_fails == [True, True, False]
    assert (report.overall.coverage, report.overall.ffr, report.overall.alignment) == (1, 0, 1)


def test_build_report_skips_inactive_criteria() -> None:
    results = [[[False, True]], [[True, False]]]
    report = build_report(results, [False, False], ffr_threshold=1.0, active=[True, False])
    assert [c.selected for c in report.criteria] == [0, 0]
    assert report.set_fails == [True, False]

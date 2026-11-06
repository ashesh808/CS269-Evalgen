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


def test_failures_preserves_missing_verdict() -> None:
    assert failures([True, False, None]) == [False, True, None]


def test_unknown_verdict_does_not_become_a_pass_or_perfect_alignment() -> None:
    report = build_report(
        [[[False, None, None], [False, True, True]]], [False, True, True], ffr_threshold=0.4
    )
    broken, valid = report.criteria[0].scores
    assert broken.coverage == 1.0
    assert broken.ffr is None and broken.alignment is None
    assert broken.confusion == Confusion(bad_failed=1, good_unknown=2)
    assert (broken.complete, broken.known_count, broken.unknown_count) == (False, 1, 2)
    assert valid.alignment == 1.0
    assert report.criteria[0].selected == 1


def test_unknown_ungraded_verdict_still_excludes_a_candidate() -> None:
    report = build_report([[[False, True, None]]], [False, True, None], ffr_threshold=0.4)
    candidate = report.criteria[0].scores[0]
    assert candidate.alignment == 1.0
    assert not candidate.complete and candidate.unknown_count == 1
    assert report.criteria[0].selected is None


def test_all_unknown_candidate_is_not_selected() -> None:
    report = build_report([[[None, None]]], [False, True], ffr_threshold=1.0)
    candidate = report.criteria[0].scores[0]
    assert candidate.confusion == Confusion(bad_unknown=1, good_unknown=1)
    assert candidate.coverage is candidate.ffr is candidate.alignment is None
    assert report.criteria[0].selected is None
    assert report.set_fails == [None, None]
    assert report.overall.ffr is None


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
    assert report.selection_complete
    assert (report.active_count, report.selected_count) == (2, 2)


def test_build_report_skips_inactive_criteria() -> None:
    results = [[[False, True]], [[True, False]]]
    report = build_report(results, [False, False], ffr_threshold=1.0, active=[True, False])
    assert [c.selected for c in report.criteria] == [0, 0]
    assert report.set_fails == [True, False]
    assert report.selection_complete
    assert (report.active_count, report.selected_count) == (1, 1)


@pytest.mark.parametrize(
    ("results", "active"),
    [([], None), ([[]], None), ([[[True, True]]], [False])],
)
def test_empty_selected_set_has_unavailable_metrics(
    results: list[list[list[bool | None]]], active: list[bool] | None
) -> None:
    report = build_report(results, [False, True], ffr_threshold=0.4, active=active)
    assert report.set_fails == [None, None]
    assert report.overall.coverage is report.overall.ffr is report.overall.alignment is None
    assert report.overall.unknown_count == 2
    assert report.selected_count == 0 and not report.selection_complete


def test_partial_selection_preserves_unknowns_but_known_failure_dominates() -> None:
    report = build_report(
        [[[False, True, True]], [[None, None, None]]],
        [False, False, True],
        ffr_threshold=0.4,
    )
    assert [criterion.selected for criterion in report.criteria] == [0, None]
    assert report.set_fails == [True, None, None]
    assert report.overall.confusion == Confusion(bad_failed=1, bad_unknown=1, good_unknown=1)
    assert report.overall.coverage is report.overall.ffr is report.overall.alignment is None
    assert (report.overall.known_count, report.overall.unknown_count) == (1, 2)
    assert (report.active_count, report.selected_count) == (2, 1)
    assert not report.selection_complete


def test_inactive_unresolved_criterion_does_not_make_the_set_unknown() -> None:
    report = build_report(
        [[[False, True]], [[None, None]]],
        [False, True],
        ffr_threshold=0.4,
        active=[True, False],
    )
    assert report.set_fails == [True, False]
    assert report.overall.alignment == 1.0 and report.overall.complete
    assert report.selection_complete


def test_report_validates_candidate_and_active_shapes() -> None:
    with pytest.raises(ValueError, match="one verdict per output"):
        build_report([[[True]]], [False, True], 0.4)
    with pytest.raises(ValueError, match="one entry per criterion"):
        build_report([[[True, False]]], [False, True], 0.4, active=[])
    with pytest.raises(ValueError, match="one failure flag and one grade"):
        score([True], [False, True])


@pytest.mark.parametrize("threshold", [-0.1, 1.1, float("nan")])
def test_selection_validates_threshold(threshold: float) -> None:
    with pytest.raises(ValueError, match="between 0 and 1"):
        select([], threshold)
    with pytest.raises(ValueError, match="between 0 and 1"):
        build_report([], [], threshold)

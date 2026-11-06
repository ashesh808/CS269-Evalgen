import pytest

from evalgen.sampling import sampling_plan


def test_selectivity_weights_failures_and_ignores_unknowns() -> None:
    results = [
        [[True, True, None, False], [False, None, None, True]],
        [[None, None, None, None]],
    ]
    plan = sampling_plan(results, [None] * 4)
    assert plan.selectivities[0] == [pytest.approx(2 / 3), 0.5]
    assert plan.selectivities[1] == [None]
    assert plan.confidence == [0.5, 0.0, 0.0, pytest.approx(2 / 3)]
    assert plan.known_counts == [2, 1, 0, 2]
    assert plan.next_index == 3 and plan.next_high


def test_alternating_policy_avoids_graded_outputs_and_breaks_ties_by_index() -> None:
    results = [[[True, True, True, False], [False, False, False, True]]]
    grades: list[bool | None] = [None] * 4
    next_high = True
    chosen = []
    for _ in range(4):
        plan = sampling_plan(results, grades, next_high)
        assert plan.next_high is next_high
        assert plan.next_index is not None
        chosen.append(plan.next_index)
        grades[plan.next_index] = False
        next_high = not next_high
    assert chosen == [3, 0, 1, 2]
    finished = sampling_plan(results, grades, next_high)
    assert finished.next_index is None
    assert finished.next_high is next_high


def test_partial_updates_reprioritize_without_advancing_alternation() -> None:
    grades: list[bool | None] = [None, None, None]
    initial = sampling_plan([[[None, None, None]]], grades, next_high=True)
    assert initial.next_index == 0 and initial.next_high
    assert initial.confidence == [0.0, 0.0, 0.0]
    assert initial.known_counts == [0, 0, 0]

    partial = sampling_plan([[[True, None, False]]], grades, next_high=True)
    assert partial.next_index == 2 and partial.next_high
    assert partial.selectivities == [[0.5]]
    grades[2] = False
    low = sampling_plan([[[True, None, False]]], grades, next_high=False)
    assert low.next_index == 0 and not low.next_high
    updated = sampling_plan([[[True, True, False]]], grades, next_high=False)
    assert updated.next_index == 0 and not updated.next_high
    assert updated.confidence == [0.0, 0.0, pytest.approx(2 / 3)]


def test_always_failing_assertions_do_not_add_confidence() -> None:
    plan = sampling_plan([[[False, False, False]]], [True, None, None])
    assert plan.selectivities == [[0.0]]
    assert plan.confidence == [0.0, 0.0, 0.0]
    assert plan.next_index == 1


def test_no_assertions_keeps_stable_ungraded_order() -> None:
    plan = sampling_plan([], [False, None, None], next_high=False)
    assert plan.selectivities == [] and plan.known_counts == [0, 0, 0]
    assert plan.confidence == [0.0, 0.0, 0.0]
    assert plan.next_index == 1 and not plan.next_high
    assert sampling_plan([], []).next_index is None


def test_sampling_validates_candidate_shapes() -> None:
    with pytest.raises(ValueError, match="one verdict per output"):
        sampling_plan([[[True, False]]], [None])

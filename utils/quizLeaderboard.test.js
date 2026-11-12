const assert = require('node:assert/strict');
const test = require('node:test');
const calculateQuizLeaderboard = require('./quizLeaderboard');

test('ranks learners by total completed quiz points and shares tied ranks', () => {
  const learners = [
    { id: 1, name: 'Avery', reg_number: 'A1', form: 'Form 1' },
    { id: 2, name: 'Blair', reg_number: 'B1', form: 'Form 1' },
    { id: 3, name: 'Casey', reg_number: 'C1', form: 'Form 1' },
    { id: 4, name: 'Drew', reg_number: 'D1', form: 'Form 1' },
  ];
  const attempts = [
    { learner_id: 1, earned_points: 8, total_points: 10 },
    { learner_id: 1, earned_points: 18, total_points: 20 },
    { learner_id: 2, earned_points: 17, total_points: 20 },
    { learner_id: 3, earned_points: 10, total_points: 10 },
    { learner_id: 4, earned_points: 13, total_points: 20 },
    { learner_id: 4, earned_points: 13, total_points: 20 },
  ];

  const leaderboard = calculateQuizLeaderboard(learners, attempts);

  assert.deepEqual(
    leaderboard.map(({ id, quiz_points, quiz_count, rank }) => ({ id, quiz_points, quiz_count, rank })),
    [
      { id: 1, quiz_points: 26, quiz_count: 2, rank: 1 },
      { id: 4, quiz_points: 26, quiz_count: 2, rank: 1 },
      { id: 2, quiz_points: 17, quiz_count: 1, rank: 3 },
      { id: 3, quiz_points: 10, quiz_count: 1, rank: 4 },
    ],
  );
});

test('converts a completed quiz percentage into points when earned points are unavailable', () => {
  const leaderboard = calculateQuizLeaderboard(
    [
      { id: 1, name: 'Avery', reg_number: 'A1', form: 'Form 1' },
      { id: 2, name: 'Blair', reg_number: 'B1', form: 'Form 1' },
    ],
    [
      { learner_id: 1, earned_points: null, percentage: 75, total_points: 20 },
      { learner_id: 2, earned_points: null, percentage: 50, total_points: 10 },
    ],
  );

  assert.deepEqual(
    leaderboard.map(({ id, quiz_points, quiz_count, rank }) => ({ id, quiz_points, quiz_count, rank })),
    [
      { id: 1, quiz_points: 15, quiz_count: 1, rank: 1 },
      { id: 2, quiz_points: 5, quiz_count: 1, rank: 2 },
    ],
  );
});

test('converts percentage to points when both percentage and earned points are present', () => {
  const leaderboard = calculateQuizLeaderboard(
    [{ id: 1, name: 'Avery', reg_number: 'A1', form: 'Form 1' }],
    [{ learner_id: 1, earned_points: 16, total_points: 20, percentage: 85 }],
  );

  assert.equal(leaderboard[0].quiz_points, 17);
});

test('uses the quiz maximum to convert a historical attempt with no recorded total points', () => {
  const leaderboard = calculateQuizLeaderboard(
    [{ id: 1, name: 'Avery', reg_number: 'A1', form: 'Form 1' }],
    [{
      learner_id: 1,
      earned_points: null,
      total_points: 0,
      quiz_total_points: 40,
      percentage: 75,
    }],
  );

  assert.equal(leaderboard[0].quiz_points, 30);
});

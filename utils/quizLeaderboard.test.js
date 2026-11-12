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

test('does not use a stored percentage when earned points are unavailable', () => {
  const leaderboard = calculateQuizLeaderboard(
    [
      { id: 1, name: 'Avery', reg_number: 'A1', form: 'Form 1' },
      { id: 2, name: 'Blair', reg_number: 'B1', form: 'Form 1' },
    ],
    [
      { learner_id: 1, earned_points: null, percentage: 100 },
      { learner_id: 2, earned_points: 0, total_points: 10, percentage: 0 },
    ],
  );

  assert.deepEqual(
    leaderboard.map(({ id, quiz_points, quiz_count, rank }) => ({ id, quiz_points, quiz_count, rank })),
    [{ id: 2, quiz_points: 0, quiz_count: 1, rank: 1 }],
  );
});

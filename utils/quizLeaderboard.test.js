const assert = require('node:assert/strict');
const test = require('node:test');
const calculateQuizLeaderboard = require('./quizLeaderboard');

test('ranks learners by their average completed quiz percentage and shares tied ranks', () => {
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
  ];

  const leaderboard = calculateQuizLeaderboard(learners, attempts);

  assert.deepEqual(
    leaderboard.map(({ id, quiz_score, quiz_count, rank }) => ({ id, quiz_score, quiz_count, rank })),
    [
      { id: 3, quiz_score: 100, quiz_count: 1, rank: 1 },
      { id: 1, quiz_score: 85, quiz_count: 2, rank: 2 },
      { id: 2, quiz_score: 85, quiz_count: 1, rank: 2 },
    ],
  );
});

test('uses a stored percentage when an attempt has no valid points denominator', () => {
  const leaderboard = calculateQuizLeaderboard(
    [{ id: 1, name: 'Avery', reg_number: 'A1', form: 'Form 1' }],
    [{ learner_id: 1, earned_points: 0, total_points: 0, percentage: 72.5 }],
  );

  assert.equal(leaderboard[0].quiz_score, 72.5);
});

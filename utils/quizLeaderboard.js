const calculateQuizLeaderboard = (learners, completedAttempts) => {
  const scoresByLearner = new Map();

  completedAttempts.forEach((attempt) => {
    const earnedPoints = Number(attempt.earned_points);
    const totalPoints = Number(attempt.total_points);
    const storedPercentage = Number(attempt.percentage);
    const hasStoredPercentage =
      attempt.percentage !== null &&
      attempt.percentage !== undefined &&
      Number.isFinite(storedPercentage);

    let percentage;
    if (Number.isFinite(earnedPoints) && Number.isFinite(totalPoints) && totalPoints > 0) {
      percentage = (earnedPoints / totalPoints) * 100;
    } else if (hasStoredPercentage) {
      percentage = storedPercentage;
    } else {
      return;
    }

    const score = scoresByLearner.get(attempt.learner_id) || { total: 0, count: 0 };
    score.total += percentage;
    score.count += 1;
    scoresByLearner.set(attempt.learner_id, score);
  });

  const leaderboard = learners
    .map((learner) => {
      const score = scoresByLearner.get(learner.id);
      if (!score || score.count === 0) return null;

      return {
        id: learner.id,
        name: learner.name,
        reg_number: learner.reg_number,
        form: learner.form,
        quiz_score: Math.round((score.total / score.count) * 100) / 100,
        quiz_count: score.count,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.quiz_score - a.quiz_score || a.name.localeCompare(b.name));

  let currentRank = 1;
  leaderboard.forEach((learner, index) => {
    if (index > 0 && learner.quiz_score !== leaderboard[index - 1].quiz_score) {
      currentRank = index + 1;
    }
    learner.rank = currentRank;
  });

  return leaderboard;
};

module.exports = calculateQuizLeaderboard;

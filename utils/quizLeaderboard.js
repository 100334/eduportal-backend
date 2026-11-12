const calculateQuizLeaderboard = (learners, completedAttempts) => {
  const pointsByLearner = new Map();

  completedAttempts.forEach((attempt) => {
    let earnedPoints;
    const percentage = Number(attempt.percentage);
    const totalPoints = Number(attempt.total_points);
    if (
      attempt.percentage !== null &&
      attempt.percentage !== undefined &&
      attempt.total_points !== null &&
      attempt.total_points !== undefined &&
      Number.isFinite(percentage) &&
      Number.isFinite(totalPoints) &&
      totalPoints > 0
    ) {
      earnedPoints = (percentage / 100) * totalPoints;
    } else if (
      attempt.earned_points !== null &&
      attempt.earned_points !== undefined &&
      Number.isFinite(Number(attempt.earned_points))
    ) {
      earnedPoints = Number(attempt.earned_points);
    } else {
      return;
    }

    const points = pointsByLearner.get(attempt.learner_id) || { total: 0, count: 0 };
    points.total += earnedPoints;
    points.count += 1;
    pointsByLearner.set(attempt.learner_id, points);
  });

  const leaderboard = learners
    .map((learner) => {
      const points = pointsByLearner.get(learner.id);
      if (!points || points.count === 0) return null;

      return {
        id: learner.id,
        name: learner.name,
        reg_number: learner.reg_number,
        form: learner.form,
        quiz_points: Math.round(points.total * 100) / 100,
        quiz_count: points.count,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.quiz_points - a.quiz_points || a.name.localeCompare(b.name));

  let currentRank = 1;
  leaderboard.forEach((learner, index) => {
    if (index > 0 && learner.quiz_points !== leaderboard[index - 1].quiz_points) {
      currentRank = index + 1;
    }
    learner.rank = currentRank;
  });

  return leaderboard;
};

module.exports = calculateQuizLeaderboard;

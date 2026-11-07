CREATE TABLE IF NOT EXISTS public.learner_login_visits (
  id BIGSERIAL PRIMARY KEY,
  learner_id INTEGER NOT NULL REFERENCES public.learners(id) ON DELETE CASCADE,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS learner_login_visits_learner_logged_in_at_idx
  ON public.learner_login_visits (learner_id, logged_in_at DESC);

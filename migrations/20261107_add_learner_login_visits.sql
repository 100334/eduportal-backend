CREATE TABLE IF NOT EXISTS public.learner_login_visits (
  id BIGSERIAL PRIMARY KEY,
  learner_id INTEGER NOT NULL REFERENCES public.learners(id) ON DELETE CASCADE,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_info TEXT
);

ALTER TABLE public.learner_login_visits
  ADD COLUMN IF NOT EXISTS device_info TEXT;

CREATE INDEX IF NOT EXISTS learner_login_visits_learner_logged_in_at_idx
  ON public.learner_login_visits (learner_id, logged_in_at DESC);

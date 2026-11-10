DO $$
DECLARE
  existing_status_check TEXT;
BEGIN
  SELECT pg_get_expr(conbin, conrelid)
  INTO existing_status_check
  FROM pg_constraint
  WHERE conrelid = 'public.quiz_attempts'::regclass
    AND conname = 'quiz_attempts_status_check'
    AND contype = 'c';

  IF existing_status_check IS NULL THEN
    ALTER TABLE public.quiz_attempts
      ADD CONSTRAINT quiz_attempts_status_check
      CHECK (status IN ('in-progress', 'completed', 'submitted', 'expired'));
  ELSE
    ALTER TABLE public.quiz_attempts
      DROP CONSTRAINT quiz_attempts_status_check;

    EXECUTE format(
      'ALTER TABLE public.quiz_attempts ADD CONSTRAINT quiz_attempts_status_check CHECK ((%s) OR status IN (%L, %L))',
      existing_status_check,
      'in-progress',
      'expired'
    );
  END IF;
END;
$$;

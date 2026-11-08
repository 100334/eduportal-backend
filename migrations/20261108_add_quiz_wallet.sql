CREATE TABLE IF NOT EXISTS public.learner_quiz_wallets (
  learner_id INTEGER PRIMARY KEY REFERENCES public.learners(id) ON DELETE CASCADE,
  balance_mwk BIGINT NOT NULL DEFAULT 0 CHECK (balance_mwk >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.learner_quiz_wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  learner_id INTEGER NOT NULL REFERENCES public.learners(id) ON DELETE CASCADE,
  amount_mwk BIGINT NOT NULL,
  balance_after_mwk BIGINT NOT NULL CHECK (balance_after_mwk >= 0),
  transaction_type TEXT NOT NULL CHECK (
    transaction_type IN ('admin_credit', 'quiz_debit', 'quiz_refund')
  ),
  reason TEXT NOT NULL,
  quiz_id TEXT,
  attempt_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS learner_quiz_wallet_transactions_attempt_type_idx
  ON public.learner_quiz_wallet_transactions (attempt_id, transaction_type)
  WHERE attempt_id IS NOT NULL
    AND transaction_type IN ('quiz_debit', 'quiz_refund');

CREATE INDEX IF NOT EXISTS learner_quiz_wallet_transactions_learner_created_idx
  ON public.learner_quiz_wallet_transactions (learner_id, created_at DESC);

ALTER TABLE public.learner_quiz_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learner_quiz_wallet_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.learner_quiz_wallets, public.learner_quiz_wallet_transactions
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.learner_quiz_wallets, public.learner_quiz_wallet_transactions
  TO service_role;
REVOKE ALL ON SEQUENCE public.learner_quiz_wallet_transactions_id_seq
  FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.learner_quiz_wallet_transactions_id_seq
  TO service_role;

INSERT INTO public.learner_quiz_wallets (learner_id)
SELECT id FROM public.learners
ON CONFLICT (learner_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.refund_expired_quiz_attempts(p_learner_id INTEGER DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  expired_attempt RECORD;
  current_balance BIGINT;
  refunded_count INTEGER := 0;
BEGIN
  FOR expired_attempt IN
    SELECT a.id, a.learner_id, a.quiz_id
    FROM public.quiz_attempts a
    WHERE a.status = 'in-progress'
      AND a.started_at <= NOW() - INTERVAL '24 hours'
      AND (p_learner_id IS NULL OR a.learner_id = p_learner_id)
      AND EXISTS (
        SELECT 1
        FROM public.learner_quiz_wallet_transactions t
        WHERE t.attempt_id = a.id::TEXT
          AND t.transaction_type = 'quiz_debit'
      )
    ORDER BY a.started_at
    FOR UPDATE OF a SKIP LOCKED
  LOOP
    INSERT INTO public.learner_quiz_wallets (learner_id)
    VALUES (expired_attempt.learner_id)
    ON CONFLICT (learner_id) DO NOTHING;

    SELECT balance_mwk INTO current_balance
    FROM public.learner_quiz_wallets
    WHERE learner_id = expired_attempt.learner_id
    FOR UPDATE;

    UPDATE public.learner_quiz_wallets
    SET balance_mwk = balance_mwk + 100,
        updated_at = NOW()
    WHERE learner_id = expired_attempt.learner_id;

    INSERT INTO public.learner_quiz_wallet_transactions (
      learner_id, amount_mwk, balance_after_mwk, transaction_type,
      reason, quiz_id, attempt_id
    )
    VALUES (
      expired_attempt.learner_id, 100, current_balance + 100, 'quiz_refund',
      'Automatic refund: quiz attempt was not submitted within 24 hours',
      expired_attempt.quiz_id::TEXT, expired_attempt.id::TEXT
    );

    UPDATE public.quiz_attempts
    SET status = 'expired', updated_at = NOW()
    WHERE id = expired_attempt.id
      AND status = 'in-progress';

    refunded_count := refunded_count + 1;
  END LOOP;

  RETURN refunded_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_paid_quiz_attempt(
  p_learner_id INTEGER,
  p_quiz_id TEXT,
  p_total_marks NUMERIC,
  p_subject TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  quiz_row public.quizzes%ROWTYPE;
  attempt_row public.quiz_attempts%ROWTYPE;
  current_balance BIGINT;
  new_balance BIGINT;
  attempts_used INTEGER;
  has_active_attempt BOOLEAN;
BEGIN
  PERFORM public.refund_expired_quiz_attempts(p_learner_id);

  SELECT * INTO quiz_row
  FROM public.quizzes
  WHERE id::TEXT = p_quiz_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'quiz_not_found');
  END IF;

  INSERT INTO public.learner_quiz_wallets (learner_id)
  VALUES (p_learner_id)
  ON CONFLICT (learner_id) DO NOTHING;

  SELECT balance_mwk INTO current_balance
  FROM public.learner_quiz_wallets
  WHERE learner_id = p_learner_id
  FOR UPDATE;

  SELECT * INTO attempt_row
  FROM public.quiz_attempts
  WHERE learner_id = p_learner_id
    AND quiz_id = quiz_row.id
    AND status = 'in-progress'
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;
  has_active_attempt := FOUND;

  SELECT COUNT(*)::INTEGER INTO attempts_used
  FROM public.quiz_attempts
  WHERE learner_id = p_learner_id
    AND quiz_id = quiz_row.id;

  IF has_active_attempt THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.learner_quiz_wallet_transactions
      WHERE attempt_id = attempt_row.id::TEXT
        AND transaction_type = 'quiz_debit'
    ) THEN
      IF current_balance < 100 THEN
        RETURN jsonb_build_object(
          'status', 'insufficient_balance',
          'balance_mwk', current_balance,
          'required_mwk', 100
        );
      END IF;

      UPDATE public.learner_quiz_wallets
      SET balance_mwk = balance_mwk - 100,
          updated_at = NOW()
      WHERE learner_id = p_learner_id
      RETURNING balance_mwk INTO new_balance;

      INSERT INTO public.learner_quiz_wallet_transactions (
        learner_id, amount_mwk, balance_after_mwk, transaction_type,
        reason, quiz_id, attempt_id
      )
      VALUES (
        p_learner_id, -100, new_balance, 'quiz_debit',
        'Quiz attempt started', quiz_row.id::TEXT, attempt_row.id::TEXT
      );

      current_balance := new_balance;
    END IF;

    RETURN jsonb_build_object(
      'status', 'resumed',
      'attempt_id', attempt_row.id,
      'attempts_used', attempts_used,
      'attempts_remaining', GREATEST(0, 2 - attempts_used),
      'balance_mwk', current_balance
    );
  END IF;

  IF attempts_used >= 2 THEN
    RETURN jsonb_build_object(
      'status', 'attempt_limit',
      'attempts_used', attempts_used,
      'attempts_remaining', 0,
      'balance_mwk', current_balance
    );
  END IF;

  IF current_balance < 100 THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_balance',
      'balance_mwk', current_balance,
      'required_mwk', 100
    );
  END IF;

  INSERT INTO public.quiz_attempts (
    learner_id, quiz_id, total_marks, total_points, status,
    started_at, subject_id, subject
  )
  VALUES (
    p_learner_id, quiz_row.id, COALESCE(p_total_marks, 0),
    COALESCE(p_total_marks, 0), 'in-progress', NOW(),
    quiz_row.subject_id, p_subject
  )
  RETURNING * INTO attempt_row;

  UPDATE public.learner_quiz_wallets
  SET balance_mwk = balance_mwk - 100,
      updated_at = NOW()
  WHERE learner_id = p_learner_id
  RETURNING balance_mwk INTO new_balance;

  INSERT INTO public.learner_quiz_wallet_transactions (
    learner_id, amount_mwk, balance_after_mwk, transaction_type,
    reason, quiz_id, attempt_id
  )
  VALUES (
    p_learner_id, -100, new_balance, 'quiz_debit',
    'Quiz attempt started', quiz_row.id::TEXT, attempt_row.id::TEXT
  );

  RETURN jsonb_build_object(
    'status', 'started',
    'attempt_id', attempt_row.id,
    'attempts_used', attempts_used + 1,
    'attempts_remaining', GREATEST(0, 1 - attempts_used),
    'balance_mwk', new_balance
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_learner_quiz_wallet(
  p_learner_id INTEGER,
  p_amount_mwk BIGINT,
  p_reason TEXT,
  p_admin_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  IF p_amount_mwk <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be greater than zero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.learners WHERE id = p_learner_id) THEN
    RAISE EXCEPTION 'Learner not found';
  END IF;

  INSERT INTO public.learner_quiz_wallets (learner_id)
  VALUES (p_learner_id)
  ON CONFLICT (learner_id) DO NOTHING;

  UPDATE public.learner_quiz_wallets
  SET balance_mwk = balance_mwk + p_amount_mwk,
      updated_at = NOW()
  WHERE learner_id = p_learner_id
  RETURNING balance_mwk INTO new_balance;

  INSERT INTO public.learner_quiz_wallet_transactions (
    learner_id, amount_mwk, balance_after_mwk, transaction_type,
    reason, created_by
  )
  VALUES (
    p_learner_id, p_amount_mwk, new_balance, 'admin_credit',
    p_reason, p_admin_id
  );

  RETURN jsonb_build_object('balance_mwk', new_balance);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_expired_quiz_attempts(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_paid_quiz_attempt(INTEGER, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.credit_learner_quiz_wallet(INTEGER, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_expired_quiz_attempts(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_paid_quiz_attempt(INTEGER, TEXT, NUMERIC, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_learner_quiz_wallet(INTEGER, BIGINT, TEXT, TEXT) TO service_role;

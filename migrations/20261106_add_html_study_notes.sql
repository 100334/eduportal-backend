ALTER TABLE public.lessons
  ADD COLUMN IF NOT EXISTS notes_html TEXT;

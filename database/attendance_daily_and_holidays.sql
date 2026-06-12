ALTER TABLE public.attendance
ADD COLUMN IF NOT EXISTS attendance_date date;

UPDATE public.attendance
SET attendance_date = (created_at AT TIME ZONE 'Asia/Makassar')::date
WHERE attendance_date IS NULL;

ALTER TABLE public.attendance
ALTER COLUMN attendance_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Makassar')::date);

ALTER TABLE public.attendance
ALTER COLUMN attendance_date SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.holiday_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  category text NOT NULL DEFAULT 'school'
    CHECK (category IN ('national', 'school', 'semester', 'special')),
  event_type text NOT NULL DEFAULT 'holiday'
    CHECK (event_type IN ('holiday', 'workday')),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS holiday_calendar_date_idx
ON public.holiday_calendar (start_date, end_date);

CREATE TABLE IF NOT EXISTS public.attendance_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  attendance_date date NOT NULL,
  masuk_attendance_id uuid REFERENCES public.attendance(id) ON DELETE SET NULL,
  pulang_attendance_id uuid REFERENCES public.attendance(id) ON DELETE SET NULL,
  masuk_at timestamptz,
  pulang_at timestamptz,
  masuk_status text NOT NULL DEFAULT 'pending'
    CHECK (masuk_status IN ('pending', 'recorded', 'missed', 'not_required', 'alpha', 'holiday')),
  pulang_status text NOT NULL DEFAULT 'pending'
    CHECK (pulang_status IN ('pending', 'recorded', 'missed', 'not_required', 'alpha', 'holiday')),
  daily_status text NOT NULL DEFAULT 'pending'
    CHECK (daily_status IN ('pending', 'hadir', 'incomplete', 'izin', 'sakit', 'alpha', 'holiday')),
  reason text,
  is_holiday boolean NOT NULL DEFAULT false,
  holiday_id uuid REFERENCES public.holiday_calendar(id) ON DELETE SET NULL,
  finalized_at timestamptz,
  corrected_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  correction_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS attendance_daily_date_idx
ON public.attendance_daily (attendance_date);

CREATE INDEX IF NOT EXISTS attendance_daily_user_date_idx
ON public.attendance_daily (user_id, attendance_date DESC);

CREATE TABLE IF NOT EXISTS public.attendance_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_daily_id uuid NOT NULL REFERENCES public.attendance_daily(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL DEFAULT 'correction',
  old_data jsonb NOT NULL,
  new_data jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_audit_daily_idx
ON public.attendance_audit_logs (attendance_daily_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.admin_calendar_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  review_month date NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_user_id, review_month),
  CHECK (review_month = date_trunc('month', review_month)::date)
);

ALTER TABLE public.holiday_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_calendar_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.holiday_calendar FROM anon, authenticated;
REVOKE ALL ON TABLE public.attendance_daily FROM anon, authenticated;
REVOKE ALL ON TABLE public.attendance_audit_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.admin_calendar_reviews FROM anon, authenticated;

GRANT ALL ON TABLE public.holiday_calendar TO postgres, service_role;
GRANT ALL ON TABLE public.attendance_daily TO postgres, service_role;
GRANT ALL ON TABLE public.attendance_audit_logs TO postgres, service_role;
GRANT ALL ON TABLE public.admin_calendar_reviews TO postgres, service_role;

INSERT INTO public.attendance_daily (
  user_id,
  attendance_date,
  masuk_attendance_id,
  pulang_attendance_id,
  masuk_at,
  pulang_at,
  masuk_status,
  pulang_status,
  daily_status,
  reason,
  finalized_at
)
SELECT
  a.user_id,
  a.attendance_date,
  (array_agg(a.id ORDER BY a.created_at)
    FILTER (WHERE a.tipe_absen = 'masuk' AND a.status <> 'rejected'))[1],
  (array_agg(a.id ORDER BY a.created_at)
    FILTER (WHERE a.tipe_absen = 'pulang' AND a.status <> 'rejected'))[1],
  min(a.created_at) FILTER (
    WHERE a.tipe_absen = 'masuk' AND a.status IN ('valid', 'hadir')
  ),
  min(a.created_at) FILTER (
    WHERE a.tipe_absen = 'pulang' AND a.status IN ('valid', 'hadir')
  ),
  CASE
    WHEN bool_or(a.status IN ('izin', 'sakit')) THEN 'not_required'
    WHEN bool_or(a.tipe_absen = 'masuk' AND a.status IN ('valid', 'hadir')) THEN 'recorded'
    ELSE 'missed'
  END,
  CASE
    WHEN bool_or(a.status IN ('izin', 'sakit')) THEN 'not_required'
    WHEN bool_or(a.tipe_absen = 'pulang' AND a.status IN ('valid', 'hadir')) THEN 'recorded'
    ELSE 'missed'
  END,
  CASE
    WHEN bool_or(a.status = 'izin') THEN 'izin'
    WHEN bool_or(a.status = 'sakit') THEN 'sakit'
    WHEN bool_or(a.tipe_absen = 'masuk' AND a.status IN ('valid', 'hadir'))
      AND bool_or(a.tipe_absen = 'pulang' AND a.status IN ('valid', 'hadir')) THEN 'hadir'
    WHEN bool_or(a.status = 'alpha') THEN 'alpha'
    ELSE 'incomplete'
  END,
  max(a.reason) FILTER (WHERE a.reason IS NOT NULL),
  now()
FROM public.attendance a
WHERE a.status <> 'rejected'
GROUP BY a.user_id, a.attendance_date
ON CONFLICT (user_id, attendance_date) DO NOTHING;

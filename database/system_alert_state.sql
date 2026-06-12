CREATE TABLE IF NOT EXISTS public.system_alert_state (
  alert_key text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('healthy', 'failed')),
  last_notified_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.system_alert_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.system_alert_state FROM anon, authenticated;
GRANT ALL ON TABLE public.system_alert_state TO postgres, service_role;

COMMENT ON TABLE public.system_alert_state IS
  'Status alert backend untuk mencegah pengiriman email berulang dari serverless cron.';

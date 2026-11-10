-- The saved sign-in a provider login renews. A login that reconnects an
-- expired account saves its result under this existing account choice, so
-- the account keeps its id, label, routes and defaults.
ALTER TABLE cloud_agent_provider_login_sessions
    ADD COLUMN IF NOT EXISTS renews_auth_choice TEXT;

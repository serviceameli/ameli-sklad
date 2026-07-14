-- Compatibility notice.
--
-- The old copy-paste bootstrap in this file could silently restore an obsolete
-- order_status view. The schema is now versioned only through:
--   supabase/migrations/202607120000_base_schema.sql
--   supabase/migrations/202607130001_order_lifecycle.sql
--   supabase/migrations/202607130002_remove_confirmed_retry_duplicates.sql
--
-- Apply the migrations in timestamp order. Access policies remain in
-- rls-policies.sql and are intentionally not changed by lifecycle migrations.

do $$
begin
  raise notice 'Use versioned files from supabase/migrations; this compatibility file makes no changes.';
end
$$;

"""Frozen initial PostgreSQL schema and immutable history guards.

Never import live application metadata into a released migration. Later schema
changes belong in new revisions so fresh installs and upgrades stay equivalent.
"""

from alembic import op

revision = "0001"
down_revision = None

SCHEMA = (
    "CREATE TABLE idempotency_keys (\n\tkey VARCHAR(200) NOT NULL, \n\trequest_hash VARCHAR(64) NOT NULL, \n\tresponse JSON NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (key)\n)",
    "CREATE TABLE outbox_events (\n\tkind VARCHAR(40) NOT NULL, \n\tpayload JSON NOT NULL, \n\tattempts INTEGER NOT NULL, \n\tavailable_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tdelivered_at TIMESTAMP WITH TIME ZONE, \n\terror VARCHAR(160), \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "CREATE TABLE rate_buckets (\n\tkey VARCHAR(120) NOT NULL, \n\tcount INTEGER NOT NULL, \n\tresets_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (key)\n)",
    "CREATE TABLE users (\n\temail VARCHAR(320) NOT NULL, \n\tname VARCHAR(120) NOT NULL, \n\tpassword_hash TEXT NOT NULL, \n\tverified BOOLEAN NOT NULL, \n\tpreferences JSON NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (email)\n)",
    "CREATE TABLE api_tokens (\n\tuser_id VARCHAR(36) NOT NULL, \n\tname VARCHAR(100) NOT NULL, \n\ttoken_hash VARCHAR(64) NOT NULL, \n\tprefix VARCHAR(18) NOT NULL, \n\tscopes JSON NOT NULL, \n\tproject_ids JSON NOT NULL, \n\texpires_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\trevoked BOOLEAN NOT NULL, \n\tlast_used_at TIMESTAMP WITH TIME ZONE, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, \n\tUNIQUE (token_hash)\n)",
    "CREATE TABLE auth_challenges (\n\tuser_id VARCHAR(36) NOT NULL, \n\ttoken_hash VARCHAR(64) NOT NULL, \n\tkind VARCHAR(20) NOT NULL, \n\texpires_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tused BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, \n\tUNIQUE (token_hash)\n)",
    "CREATE TABLE projects (\n\tname VARCHAR(160) NOT NULL, \n\tkey VARCHAR(12) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tguide TEXT NOT NULL, \n\towner_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tnext_case INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(owner_id) REFERENCES users (id)\n)",
    "CREATE TABLE sessions (\n\tuser_id VARCHAR(36) NOT NULL, \n\ttoken_hash VARCHAR(64) NOT NULL, \n\tcsrf VARCHAR(80) NOT NULL, \n\texpires_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, \n\tUNIQUE (token_hash)\n)",
    "CREATE TABLE audit_events (\n\tproject_id VARCHAR(36) NOT NULL, \n\tactor_id VARCHAR(36) NOT NULL, \n\taction VARCHAR(80) NOT NULL, \n\tresource_id VARCHAR(36), \n\tmetadata JSON NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id), \n\tFOREIGN KEY(actor_id) REFERENCES users (id)\n)",
    "CREATE TABLE environments (\n\tname VARCHAR(160) NOT NULL, \n\tbase_url TEXT NOT NULL, \n\tdescription TEXT NOT NULL, \n\tconfiguration JSON NOT NULL, \n\tproject_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE\n)",
    "CREATE TABLE folders (\n\tname VARCHAR(160) NOT NULL, \n\tparent_id VARCHAR(36), \n\tposition INTEGER NOT NULL, \n\tproject_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(parent_id) REFERENCES folders (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE\n)",
    "CREATE TABLE notifications (\n\tproject_id VARCHAR(36) NOT NULL, \n\tuser_id VARCHAR(36) NOT NULL, \n\tevent VARCHAR(60) NOT NULL, \n\ttitle VARCHAR(240) NOT NULL, \n\tresource_type VARCHAR(40) NOT NULL, \n\tresource_id VARCHAR(36) NOT NULL, \n\tread BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id), \n\tFOREIGN KEY(user_id) REFERENCES users (id)\n)",
    "CREATE TABLE project_invitations (\n\tproject_id VARCHAR(36) NOT NULL, \n\temail VARCHAR(320) NOT NULL, \n\trole VARCHAR(20) NOT NULL, \n\ttoken_hash VARCHAR(64) NOT NULL, \n\texpires_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\trevoked BOOLEAN NOT NULL, \n\taccepted BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, \n\tUNIQUE (token_hash)\n)",
    "CREATE TABLE project_memberships (\n\tproject_id VARCHAR(36) NOT NULL, \n\tuser_id VARCHAR(36) NOT NULL, \n\trole VARCHAR(20) NOT NULL, \n\tcan_read_secrets BOOLEAN NOT NULL, \n\tcan_write_secrets BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (project_id, user_id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, \n\tFOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE\n)",
    "CREATE TABLE reports (\n\tproject_id VARCHAR(36) NOT NULL, \n\ttitle VARCHAR(240) NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\taudience VARCHAR(20) NOT NULL, \n\tinterim BOOLEAN NOT NULL, \n\tsnapshot JSON NOT NULL, \n\tcontent_hash VARCHAR(64) NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE specifications (\n\ttitle VARCHAR(240) NOT NULL, \n\tdescription TEXT NOT NULL, \n\ttags JSON NOT NULL, \n\tacceptance_criteria TEXT NOT NULL, \n\tcurrent_revision_id VARCHAR(36), \n\tproject_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE\n)",
    "CREATE TABLE subscriptions (\n\tproject_id VARCHAR(36) NOT NULL, \n\tuser_id VARCHAR(36) NOT NULL, \n\tresource_type VARCHAR(40) NOT NULL, \n\tresource_id VARCHAR(36) NOT NULL, \n\tlevel VARCHAR(20) NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (user_id, project_id, resource_type, resource_id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id), \n\tFOREIGN KEY(user_id) REFERENCES users (id)\n)",
    "CREATE TABLE user_plans (\n\ttitle VARCHAR(240) NOT NULL, \n\tstatus VARCHAR(20) NOT NULL, \n\tcurrent_revision_id VARCHAR(36), \n\tproject_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE\n)",
    "CREATE TABLE plan_revisions (\n\tplan_id VARCHAR(36) NOT NULL, \n\tnumber INTEGER NOT NULL, \n\tcontent JSON NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(plan_id) REFERENCES user_plans (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE specification_revisions (\n\tspecification_id VARCHAR(36) NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tnumber INTEGER NOT NULL, \n\tcontent JSON NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(specification_id) REFERENCES specifications (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE test_accounts (\n\tname VARCHAR(160) NOT NULL, \n\tlogin VARCHAR(320) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tapplication_role VARCHAR(120) NOT NULL, \n\tenvironment_id VARCHAR(36), \n\tencrypted_secret BYTEA, \n\tkey_version INTEGER NOT NULL, \n\tproject_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(environment_id) REFERENCES environments (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE\n)",
    "CREATE TABLE use_cases (\n\tkey VARCHAR(32) NOT NULL, \n\tfolder_id VARCHAR(36), \n\ttitle VARCHAR(240) NOT NULL, \n\tworking_revision_id VARCHAR(36), \n\tcurrent_publication_id VARCHAR(36), \n\tproject_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (project_id, key), \n\tFOREIGN KEY(folder_id) REFERENCES folders (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE\n)",
    "CREATE TABLE comment_threads (\n\tproject_id VARCHAR(36) NOT NULL, \n\tuse_case_id VARCHAR(36) NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tanchor JSON, \n\tvisibility VARCHAR(20) NOT NULL, \n\tresolved BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id), \n\tFOREIGN KEY(use_case_id) REFERENCES use_cases (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE proposals (\n\ttitle VARCHAR(240) NOT NULL, \n\tkind VARCHAR(40) NOT NULL, \n\tstatus VARCHAR(20) NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\ttarget_use_case_id VARCHAR(36), \n\tcontent JSON NOT NULL, \n\tdecision JSON, \n\tproject_id VARCHAR(36) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tarchived BOOLEAN NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id), \n\tFOREIGN KEY(target_use_case_id) REFERENCES use_cases (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE\n)",
    "CREATE TABLE runs (\n\tproject_id VARCHAR(36) NOT NULL, \n\ttitle VARCHAR(240) NOT NULL, \n\tstatus VARCHAR(20) NOT NULL, \n\tsource VARCHAR(20) NOT NULL, \n\tplan_revision_id VARCHAR(36), \n\tauthor_id VARCHAR(36) NOT NULL, \n\tenvironment JSON NOT NULL, \n\tbuild VARCHAR(240) NOT NULL, \n\tversion INTEGER NOT NULL, \n\tfinished_at TIMESTAMP WITH TIME ZONE, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id), \n\tFOREIGN KEY(plan_revision_id) REFERENCES plan_revisions (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE use_case_revisions (\n\tuse_case_id VARCHAR(36) NOT NULL, \n\tnumber INTEGER NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tmessage TEXT NOT NULL, \n\tcontent JSON NOT NULL, \n\tcontent_hash VARCHAR(64) NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (use_case_id, number), \n\tFOREIGN KEY(use_case_id) REFERENCES use_cases (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE case_accounts (\n\trevision_id VARCHAR(36) NOT NULL, \n\taccount_id VARCHAR(36) NOT NULL, \n\talias VARCHAR(80) NOT NULL, \n\tPRIMARY KEY (revision_id, account_id), \n\tFOREIGN KEY(revision_id) REFERENCES use_case_revisions (id), \n\tFOREIGN KEY(account_id) REFERENCES test_accounts (id)\n)",
    "CREATE TABLE case_specifications (\n\trevision_id VARCHAR(36) NOT NULL, \n\tspecification_id VARCHAR(36) NOT NULL, \n\tspecification_revision_id VARCHAR(36) NOT NULL, \n\tPRIMARY KEY (revision_id, specification_id), \n\tFOREIGN KEY(revision_id) REFERENCES use_case_revisions (id), \n\tFOREIGN KEY(specification_id) REFERENCES specifications (id), \n\tFOREIGN KEY(specification_revision_id) REFERENCES specification_revisions (id)\n)",
    "CREATE TABLE case_variants (\n\trevision_id VARCHAR(36) NOT NULL, \n\tvariant_key VARCHAR(80) NOT NULL, \n\tpolarity VARCHAR(12) NOT NULL, \n\tcontent JSON NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(revision_id) REFERENCES use_case_revisions (id)\n)",
    "CREATE TABLE comments (\n\tthread_id VARCHAR(36) NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tbody TEXT NOT NULL, \n\thistory JSON NOT NULL, \n\tdeleted BOOLEAN NOT NULL, \n\tupdated_at TIMESTAMP WITH TIME ZONE, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(thread_id) REFERENCES comment_threads (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE proposal_revisions (\n\tproposal_id VARCHAR(36) NOT NULL, \n\tnumber INTEGER NOT NULL, \n\tcontent JSON NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(proposal_id) REFERENCES proposals (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE publications (\n\tuse_case_id VARCHAR(36) NOT NULL, \n\trevision_id VARCHAR(36) NOT NULL, \n\tnumber INTEGER NOT NULL, \n\tmessage TEXT NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (use_case_id, number), \n\tFOREIGN KEY(use_case_id) REFERENCES use_cases (id), \n\tFOREIGN KEY(revision_id) REFERENCES use_case_revisions (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE report_runs (\n\treport_id VARCHAR(36) NOT NULL, \n\trun_id VARCHAR(36) NOT NULL, \n\tPRIMARY KEY (report_id, run_id), \n\tFOREIGN KEY(report_id) REFERENCES reports (id), \n\tFOREIGN KEY(run_id) REFERENCES runs (id)\n)",
    "CREATE TABLE run_items (\n\trun_id VARCHAR(36) NOT NULL, \n\tuse_case_id VARCHAR(36) NOT NULL, \n\tpublication_id VARCHAR(36) NOT NULL, \n\trevision_id VARCHAR(36) NOT NULL, \n\tsnapshot JSON NOT NULL, \n\tvariant_key VARCHAR(80), \n\tassignee_id VARCHAR(36), \n\tposition INTEGER NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(run_id) REFERENCES runs (id), \n\tFOREIGN KEY(use_case_id) REFERENCES use_cases (id), \n\tFOREIGN KEY(publication_id) REFERENCES publications (id), \n\tFOREIGN KEY(revision_id) REFERENCES use_case_revisions (id), \n\tFOREIGN KEY(assignee_id) REFERENCES users (id)\n)",
    "CREATE TABLE executions (\n\trun_item_id VARCHAR(36) NOT NULL, \n\tattempt INTEGER NOT NULL, \n\tstatus VARCHAR(20) NOT NULL, \n\tactor_id VARCHAR(36), \n\tsource VARCHAR(20) NOT NULL, \n\tactual_result TEXT NOT NULL, \n\tsteps JSON NOT NULL, \n\texternal_issue_url TEXT NOT NULL, \n\tstarted_at TIMESTAMP WITH TIME ZONE, \n\tfinished_at TIMESTAMP WITH TIME ZONE, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (run_item_id, attempt), \n\tFOREIGN KEY(run_item_id) REFERENCES run_items (id), \n\tFOREIGN KEY(actor_id) REFERENCES users (id)\n)",
    "CREATE TABLE attachments (\n\tproject_id VARCHAR(36) NOT NULL, \n\texecution_id VARCHAR(36) NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tfilename VARCHAR(240) NOT NULL, \n\tcontent_type VARCHAR(120) NOT NULL, \n\tsize INTEGER NOT NULL, \n\tsha256 VARCHAR(64) NOT NULL, \n\tstorage_key VARCHAR(80) NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(project_id) REFERENCES projects (id), \n\tFOREIGN KEY(execution_id) REFERENCES executions (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE TABLE execution_annotations (\n\texecution_id VARCHAR(36) NOT NULL, \n\tauthor_id VARCHAR(36) NOT NULL, \n\tbody TEXT NOT NULL, \n\tid VARCHAR(36) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(execution_id) REFERENCES executions (id), \n\tFOREIGN KEY(author_id) REFERENCES users (id)\n)",
    "CREATE INDEX ix_outbox_pending ON outbox_events (delivered_at, available_at)",
    "CREATE INDEX ix_api_tokens_user_id ON api_tokens (user_id)",
    "CREATE INDEX ix_sessions_user_id ON sessions (user_id)",
    "CREATE INDEX ix_audit_events_project_id ON audit_events (project_id)",
    "CREATE INDEX ix_environments_project_id ON environments (project_id)",
    "CREATE INDEX ix_folders_project_id ON folders (project_id)",
    "CREATE INDEX ix_notifications_project_id ON notifications (project_id)",
    "CREATE INDEX ix_notifications_user_id ON notifications (user_id)",
    "CREATE INDEX ix_project_invitations_project_id ON project_invitations (project_id)",
    "CREATE INDEX ix_project_memberships_project_id ON project_memberships (project_id)",
    "CREATE INDEX ix_reports_project_id ON reports (project_id)",
    "CREATE INDEX ix_specifications_project_id ON specifications (project_id)",
    "CREATE INDEX ix_subscriptions_project_id ON subscriptions (project_id)",
    "CREATE INDEX ix_user_plans_project_id ON user_plans (project_id)",
    "CREATE INDEX ix_plan_revisions_plan_id ON plan_revisions (plan_id)",
    "CREATE INDEX ix_specification_revisions_specification_id ON specification_revisions (specification_id)",
    "CREATE INDEX ix_test_accounts_project_id ON test_accounts (project_id)",
    "CREATE INDEX ix_use_cases_project_id ON use_cases (project_id)",
    "CREATE INDEX ix_comment_threads_project_id ON comment_threads (project_id)",
    "CREATE INDEX ix_comment_threads_use_case_id ON comment_threads (use_case_id)",
    "CREATE INDEX ix_proposals_project_id ON proposals (project_id)",
    "CREATE INDEX ix_runs_project_id ON runs (project_id)",
    "CREATE INDEX ix_use_case_revisions_use_case_id ON use_case_revisions (use_case_id)",
    "CREATE INDEX ix_case_variants_revision_id ON case_variants (revision_id)",
    "CREATE INDEX ix_comments_thread_id ON comments (thread_id)",
    "CREATE INDEX ix_proposal_revisions_proposal_id ON proposal_revisions (proposal_id)",
    "CREATE INDEX ix_publications_use_case_id ON publications (use_case_id)",
    "CREATE INDEX ix_run_items_run_id ON run_items (run_id)",
    "CREATE INDEX ix_run_items_use_case_id ON run_items (use_case_id)",
    "CREATE INDEX ix_executions_run_item_id ON executions (run_item_id)",
    "CREATE INDEX ix_attachments_project_id ON attachments (project_id)",
    "CREATE INDEX ix_execution_annotations_execution_id ON execution_annotations (execution_id)",
)
TABLES = (
    "idempotency_keys",
    "outbox_events",
    "rate_buckets",
    "users",
    "api_tokens",
    "auth_challenges",
    "projects",
    "sessions",
    "audit_events",
    "environments",
    "folders",
    "notifications",
    "project_invitations",
    "project_memberships",
    "reports",
    "specifications",
    "subscriptions",
    "user_plans",
    "plan_revisions",
    "specification_revisions",
    "test_accounts",
    "use_cases",
    "comment_threads",
    "proposals",
    "runs",
    "use_case_revisions",
    "case_accounts",
    "case_specifications",
    "case_variants",
    "comments",
    "proposal_revisions",
    "publications",
    "report_runs",
    "run_items",
    "executions",
    "attachments",
    "execution_annotations",
)


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        raise RuntimeError("Testcase requires PostgreSQL")
    for statement in SCHEMA:
        op.execute(statement)
    if bind.dialect.name == "postgresql":
        op.execute("""CREATE FUNCTION reject_snapshot_mutation() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'immutable_snapshot'; END; $$ LANGUAGE plpgsql""")
        for table in [
            "use_case_revisions",
            "case_variants",
            "case_specifications",
            "case_accounts",
            "publications",
            "specification_revisions",
            "proposal_revisions",
            "plan_revisions",
            "reports",
            "report_runs",
            "execution_annotations",
            "audit_events",
        ]:
            op.execute(
                f"CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION reject_snapshot_mutation()"
            )
        op.execute("""CREATE FUNCTION protect_execution_result() RETURNS trigger AS $$
        BEGIN IF OLD.status IN ('passed','failed','blocked','skipped','cancelled') THEN
        RAISE EXCEPTION 'immutable_execution'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql""")
        op.execute(
            "CREATE TRIGGER immutable_execution BEFORE UPDATE ON executions FOR EACH ROW EXECUTE FUNCTION protect_execution_result()"
        )


def downgrade():
    for name in reversed(TABLES):
        op.execute(f'DROP TABLE "{name}"')
    op.execute("DROP FUNCTION IF EXISTS reject_snapshot_mutation()")
    op.execute("DROP FUNCTION IF EXISTS protect_execution_result()")

"""Extend existing threads and audit without replacing historical data."""

import sqlalchemy as sa
from alembic import op

revision = "0005_discussion_activity"
down_revision = "0004_draft_runs_readiness"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("comment_threads", "use_case_id", existing_type=sa.String(36), nullable=True)
    op.add_column(
        "comment_threads", sa.Column("target_type", sa.String(20), nullable=False, server_default="use_case")
    )
    op.add_column("comment_threads", sa.Column("target_id", sa.String(36), nullable=True))
    op.execute("UPDATE comment_threads SET target_id = use_case_id")
    # Legacy comments predate discussion audit events. Deterministic IDs make a
    # downgrade/re-upgrade safe without copying message bodies into the audit.
    op.execute("""INSERT INTO audit_events (id, created_at, project_id, actor_id, action, resource_id, metadata)
        SELECT md5(c.id || '-discussion')::uuid::text, c.created_at, t.project_id, c.author_id,
               CASE WHEN row_number() OVER (PARTITION BY c.thread_id ORDER BY c.created_at, c.id) = 1
                    THEN 'discussion.created' ELSE 'discussion.replied' END,
               c.thread_id, '{"source":"migration"}'::json
        FROM comments c JOIN comment_threads t ON t.id = c.thread_id
        ON CONFLICT (id) DO NOTHING""")
    op.create_index("ix_thread_target", "comment_threads", ["project_id", "target_type", "target_id"])
    op.create_index("ix_activity_order", "audit_events", ["project_id", "created_at", "id"])
    op.create_table(
        "activity_reads",
        sa.Column(
            "event_id", sa.String(36), sa.ForeignKey("audit_events.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM comment_threads WHERE use_case_id IS NULL")):
        raise RuntimeError(
            "Non-case discussions exist; restore a backup rather than deleting discussion history"
        )
    op.drop_table("activity_reads")
    op.drop_index("ix_activity_order", "audit_events")
    op.drop_index("ix_thread_target", "comment_threads")
    op.drop_column("comment_threads", "target_id")
    op.drop_column("comment_threads", "target_type")
    op.alter_column("comment_threads", "use_case_id", existing_type=sa.String(36), nullable=False)

"""Pinned draft executions and explicit pre-run readiness; preserve legacy histories."""

import sqlalchemy as sa
from alembic import op

revision = "0004_draft_runs_readiness"
down_revision = "0003_specification_folders"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("run_items", "publication_id", existing_type=sa.String(36), nullable=True)
    op.add_column("runs", sa.Column("case_source", sa.String(20), nullable=False, server_default="published"))
    op.add_column("runs", sa.Column("readiness", sa.JSON(), nullable=False, server_default="{}"))
    op.create_check_constraint("ck_runs_case_source", "runs", "case_source IN ('published', 'draft')")


def downgrade():
    connection = op.get_bind()
    if connection.scalar(sa.text("SELECT count(*) FROM run_items WHERE publication_id IS NULL")):
        raise RuntimeError(
            "Draft run history exists. Restore a backup rather than deleting its pinned results."
        )
    op.drop_constraint("ck_runs_case_source", "runs")
    op.drop_column("runs", "readiness")
    op.drop_column("runs", "case_source")
    op.alter_column("run_items", "publication_id", existing_type=sa.String(36), nullable=False)

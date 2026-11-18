"""Explicit dynamic access; legacy empty and selected lists remain restricted."""
import sqlalchemy as sa
from alembic import op

revision = "0006_token_project_access"
down_revision = "0005_discussion_activity"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("api_tokens", sa.Column("project_access", sa.String(20), nullable=False, server_default="selected"))
    op.add_column("api_tokens", sa.Column("access_version", sa.Integer(), nullable=False, server_default="1"))
    op.create_check_constraint("ck_token_project_access", "api_tokens", "project_access IN ('selected', 'all') AND (project_access != 'all' OR json_array_length(project_ids) = 0)")
    op.create_check_constraint("ck_token_access_version", "api_tokens", "access_version >= 1")


def downgrade():
    op.drop_constraint("ck_token_access_version", "api_tokens")
    op.drop_constraint("ck_token_project_access", "api_tokens")
    op.drop_column("api_tokens", "access_version")
    op.drop_column("api_tokens", "project_access")

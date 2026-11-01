"""Project label dictionaries and case plan naming, preserving existing data."""

import sqlalchemy as sa
from alembic import op

revision = "0002_catalog"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "project_labels",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "project_id", sa.String(36), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("scope", sa.String(30), nullable=False),
        sa.Column("normalized", sa.String(240), nullable=False),
        sa.Column("value", sa.String(80), nullable=False),
        sa.UniqueConstraint("project_id", "scope", "normalized"),
    )
    op.create_index("ix_project_labels_project_id", "project_labels", ["project_id"])
    # Seed each dictionary separately from existing revisions, including removed labels.
    op.execute("""INSERT INTO project_labels (id, created_at, project_id, scope, normalized, value)
        SELECT md5(project_id || scope || lower(trim(value))), now(), project_id, scope,
               lower(trim(value)), min(trim(value))
        FROM (
          SELECT c.project_id, 'use_cases' AS scope, json_array_elements_text(r.content->'tags') AS value
          FROM use_case_revisions r JOIN use_cases c ON c.id=r.use_case_id
          UNION ALL
          SELECT c.project_id, 'platforms', json_array_elements_text(r.content->'platforms')
          FROM use_case_revisions r JOIN use_cases c ON c.id=r.use_case_id
          UNION ALL
          SELECT s.project_id, 'specifications', json_array_elements_text(r.content->'tags')
          FROM specification_revisions r JOIN specifications s ON s.id=r.specification_id
        ) labels WHERE length(trim(value)) BETWEEN 1 AND 80
        GROUP BY project_id, scope, lower(trim(value)) ON CONFLICT DO NOTHING""")
    op.rename_table("user_plans", "case_plans")
    op.execute("ALTER INDEX ix_user_plans_project_id RENAME TO ix_case_plans_project_id")


def downgrade():
    op.rename_table("case_plans", "user_plans")
    op.execute("ALTER INDEX ix_case_plans_project_id RENAME TO ix_user_plans_project_id")
    op.drop_table("project_labels")

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def uid():
    return str(uuid4())


def now():
    return datetime.now(timezone.utc)


class Identity:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class User(Identity, Base):
    __tablename__ = "users"
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(Text)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)


class Session(Identity, Base):
    __tablename__ = "sessions"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf: Mapped[str] = mapped_column(String(80))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuthChallenge(Identity, Base):
    __tablename__ = "auth_challenges"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    kind: Mapped[str] = mapped_column(String(20))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class RateBucket(Base):
    __tablename__ = "rate_buckets"
    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, default=0)
    resets_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Project(Identity, Base):
    __tablename__ = "projects"
    name: Mapped[str] = mapped_column(String(160))
    key: Mapped[str] = mapped_column(String(12))
    description: Mapped[str] = mapped_column(Text, default="")
    guide: Mapped[str] = mapped_column(Text, default="")
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    version: Mapped[int] = mapped_column(Integer, default=1)
    next_case: Mapped[int] = mapped_column(Integer, default=1)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)


class ProjectLabel(Identity, Base):
    __tablename__ = "project_labels"
    __table_args__ = (UniqueConstraint("project_id", "scope", "normalized"),)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    scope: Mapped[str] = mapped_column(String(30))
    normalized: Mapped[str] = mapped_column(String(240))
    value: Mapped[str] = mapped_column(String(80))


class Membership(Identity, Base):
    __tablename__ = "project_memberships"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(20))
    can_read_secrets: Mapped[bool] = mapped_column(Boolean, default=False)
    can_write_secrets: Mapped[bool] = mapped_column(Boolean, default=False)


class Invitation(Identity, Base):
    __tablename__ = "project_invitations"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(320))
    role: Mapped[str] = mapped_column(String(20))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    accepted: Mapped[bool] = mapped_column(Boolean, default=False)


class ApiToken(Identity, Base):
    __tablename__ = "api_tokens"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(18))
    scopes: Mapped[list] = mapped_column(JSON)
    project_ids: Mapped[list] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProjectObject(Identity):
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)


class Folder(ProjectObject, Base):
    __tablename__ = "folders"
    __table_args__ = (
        CheckConstraint("kind IN ('use_cases', 'specifications')", name="ck_folders_kind"),
        Index("ix_folders_project_kind_parent", "project_id", "kind", "parent_id"),
    )
    kind: Mapped[str] = mapped_column(String(30), default="use_cases", server_default="use_cases")
    name: Mapped[str] = mapped_column(String(160))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id"))
    position: Mapped[int] = mapped_column(Integer, default=0)


class Specification(ProjectObject, Base):
    __tablename__ = "specifications"
    folder_id: Mapped[str | None] = mapped_column(
        ForeignKey("folders.id", name="fk_specifications_folder"), index=True
    )
    title: Mapped[str] = mapped_column(String(240))
    description: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    acceptance_criteria: Mapped[str] = mapped_column(Text, default="")
    current_revision_id: Mapped[str | None] = mapped_column(String(36))


class SpecificationRevision(Identity, Base):
    __tablename__ = "specification_revisions"
    specification_id: Mapped[str] = mapped_column(ForeignKey("specifications.id"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    number: Mapped[int] = mapped_column(Integer)
    content: Mapped[dict] = mapped_column(JSON)


class Environment(ProjectObject, Base):
    __tablename__ = "environments"
    name: Mapped[str] = mapped_column(String(160))
    base_url: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    configuration: Mapped[dict] = mapped_column(JSON, default=dict)


class TestAccount(ProjectObject, Base):
    __tablename__ = "test_accounts"
    name: Mapped[str] = mapped_column(String(160))
    login: Mapped[str] = mapped_column(String(320), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    application_role: Mapped[str] = mapped_column(String(120), default="")
    environment_id: Mapped[str | None] = mapped_column(ForeignKey("environments.id"))
    encrypted_secret: Mapped[bytes | None] = mapped_column(LargeBinary)
    key_version: Mapped[int] = mapped_column(Integer, default=1)


class UseCase(ProjectObject, Base):
    __tablename__ = "use_cases"
    __table_args__ = (UniqueConstraint("project_id", "key"),)
    key: Mapped[str] = mapped_column(String(32))
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id"))
    title: Mapped[str] = mapped_column(String(240))
    working_revision_id: Mapped[str | None] = mapped_column(String(36))
    current_publication_id: Mapped[str | None] = mapped_column(String(36))


class UseCaseRevision(Identity, Base):
    __tablename__ = "use_case_revisions"
    __table_args__ = (UniqueConstraint("use_case_id", "number"),)
    use_case_id: Mapped[str] = mapped_column(ForeignKey("use_cases.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    message: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[dict] = mapped_column(JSON)
    content_hash: Mapped[str] = mapped_column(String(64))


class CaseVariant(Identity, Base):
    __tablename__ = "case_variants"
    revision_id: Mapped[str] = mapped_column(ForeignKey("use_case_revisions.id"), index=True)
    variant_key: Mapped[str] = mapped_column(String(80))
    polarity: Mapped[str] = mapped_column(String(12))
    content: Mapped[dict] = mapped_column(JSON)


class CaseSpecification(Base):
    __tablename__ = "case_specifications"
    revision_id: Mapped[str] = mapped_column(ForeignKey("use_case_revisions.id"), primary_key=True)
    specification_id: Mapped[str] = mapped_column(ForeignKey("specifications.id"), primary_key=True)
    specification_revision_id: Mapped[str] = mapped_column(ForeignKey("specification_revisions.id"))


class CaseAccount(Base):
    __tablename__ = "case_accounts"
    revision_id: Mapped[str] = mapped_column(ForeignKey("use_case_revisions.id"), primary_key=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("test_accounts.id"), primary_key=True)
    alias: Mapped[str] = mapped_column(String(80))


class Publication(Identity, Base):
    __tablename__ = "publications"
    __table_args__ = (UniqueConstraint("use_case_id", "number"),)
    use_case_id: Mapped[str] = mapped_column(ForeignKey("use_cases.id"), index=True)
    revision_id: Mapped[str] = mapped_column(ForeignKey("use_case_revisions.id"))
    number: Mapped[int] = mapped_column(Integer)
    message: Mapped[str] = mapped_column(Text)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))


class Proposal(ProjectObject, Base):
    __tablename__ = "proposals"
    title: Mapped[str] = mapped_column(String(240))
    kind: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), default="open")
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    target_use_case_id: Mapped[str | None] = mapped_column(ForeignKey("use_cases.id"))
    content: Mapped[dict] = mapped_column(JSON)
    decision: Mapped[dict | None] = mapped_column(JSON)


class ProposalRevision(Identity, Base):
    __tablename__ = "proposal_revisions"
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    content: Mapped[dict] = mapped_column(JSON)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))


class CasePlan(ProjectObject, Base):
    __tablename__ = "case_plans"
    title: Mapped[str] = mapped_column(String(240))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    current_revision_id: Mapped[str | None] = mapped_column(String(36))


class PlanRevision(Identity, Base):
    __tablename__ = "plan_revisions"
    plan_id: Mapped[str] = mapped_column(ForeignKey("case_plans.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    content: Mapped[dict] = mapped_column(JSON)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))


class Run(Identity, Base):
    __tablename__ = "runs"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(240))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    source: Mapped[str] = mapped_column(String(20), default="manual")
    plan_revision_id: Mapped[str | None] = mapped_column(ForeignKey("plan_revisions.id"))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    environment: Mapped[dict] = mapped_column(JSON, default=dict)
    build: Mapped[str] = mapped_column(String(240), default="")
    case_source: Mapped[str] = mapped_column(String(20), default="published")
    readiness: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RunItem(Identity, Base):
    __tablename__ = "run_items"
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    use_case_id: Mapped[str] = mapped_column(ForeignKey("use_cases.id"), index=True)
    publication_id: Mapped[str | None] = mapped_column(ForeignKey("publications.id"))
    revision_id: Mapped[str] = mapped_column(ForeignKey("use_case_revisions.id"))
    snapshot: Mapped[dict] = mapped_column(JSON)
    variant_key: Mapped[str | None] = mapped_column(String(80))
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    position: Mapped[int] = mapped_column(Integer)


class Execution(Identity, Base):
    __tablename__ = "executions"
    __table_args__ = (UniqueConstraint("run_item_id", "attempt"),)
    run_item_id: Mapped[str] = mapped_column(ForeignKey("run_items.id"), index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    source: Mapped[str] = mapped_column(String(20), default="manual")
    actual_result: Mapped[str] = mapped_column(Text, default="")
    steps: Mapped[dict] = mapped_column(JSON, default=dict)
    external_issue_url: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ExecutionAnnotation(Identity, Base):
    __tablename__ = "execution_annotations"
    execution_id: Mapped[str] = mapped_column(ForeignKey("executions.id"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)


class Attachment(Identity, Base):
    __tablename__ = "attachments"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    execution_id: Mapped[str] = mapped_column(ForeignKey("executions.id"))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(240))
    content_type: Mapped[str] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(80))


class Thread(Identity, Base):
    __tablename__ = "comment_threads"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    use_case_id: Mapped[str | None] = mapped_column(ForeignKey("use_cases.id"), index=True)
    target_type: Mapped[str] = mapped_column(String(20), default="use_case")
    target_id: Mapped[str | None] = mapped_column(String(36))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    anchor: Mapped[dict | None] = mapped_column(JSON)
    visibility: Mapped[str] = mapped_column(String(20), default="project")
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)


class Comment(Identity, Base):
    __tablename__ = "comments"
    thread_id: Mapped[str] = mapped_column(ForeignKey("comment_threads.id"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)
    history: Mapped[list] = mapped_column(JSON, default=list)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Report(Identity, Base):
    __tablename__ = "reports"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(240))
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    audience: Mapped[str] = mapped_column(String(20), default="project")
    interim: Mapped[bool] = mapped_column(Boolean, default=False)
    snapshot: Mapped[dict] = mapped_column(JSON)
    content_hash: Mapped[str] = mapped_column(String(64))


class ReportRun(Base):
    __tablename__ = "report_runs"
    report_id: Mapped[str] = mapped_column(ForeignKey("reports.id"), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), primary_key=True)


class Notification(Identity, Base):
    __tablename__ = "notifications"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    event: Mapped[str] = mapped_column(String(60))
    title: Mapped[str] = mapped_column(String(240))
    resource_type: Mapped[str] = mapped_column(String(40))
    resource_id: Mapped[str] = mapped_column(String(36))
    read: Mapped[bool] = mapped_column(Boolean, default=False)


class Subscription(Identity, Base):
    __tablename__ = "subscriptions"
    __table_args__ = (UniqueConstraint("user_id", "project_id", "resource_type", "resource_id"),)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    resource_type: Mapped[str] = mapped_column(String(40))
    resource_id: Mapped[str] = mapped_column(String(36))
    level: Mapped[str] = mapped_column(String(20), default="important")


class Outbox(Identity, Base):
    __tablename__ = "outbox_events"
    kind: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String(160))


class Audit(Identity, Base):
    __tablename__ = "audit_events"
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(80))
    resource_id: Mapped[str | None] = mapped_column(String(36))
    metadata_: Mapped[dict] = mapped_column("metadata", JSON, default=dict)


class Idempotency(Base):
    __tablename__ = "idempotency_keys"
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


Index("ix_outbox_pending", Outbox.delivered_at, Outbox.available_at)


class ActivityRead(Base):
    __tablename__ = "activity_reads"
    event_id: Mapped[str] = mapped_column(ForeignKey("audit_events.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


Index("ix_thread_target", Thread.project_id, Thread.target_type, Thread.target_id)
Index("ix_activity_order", Audit.project_id, Audit.created_at, Audit.id)

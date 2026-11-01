from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

Outcome = Literal["passed", "failed", "scenario_issue", "blocked", "skipped"]
CaseSource = Literal["published", "draft"]


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("title", "name", "action", "expected", "description", mode="before", check_fields=False)
    @classmethod
    def trim_text(cls, value):
        """Trim descriptive fields before length checks; input data and secrets remain literal."""
        return value.strip() if isinstance(value, str) else value


class ReadinessChecks(Schema):
    """Executor attestations, not automatic claims about external system availability."""

    environment: Literal["ready", "blocked", "not_checked"] = "not_checked"
    accounts: Literal["ready", "blocked", "not_required", "not_checked"] = "not_checked"
    dependencies: Literal["ready", "blocked", "not_required", "not_checked"] = "not_checked"


class Step(Schema):
    key: str = Field(default_factory=lambda: str(uuid4()), min_length=1, max_length=80)
    action: str = Field(min_length=1, max_length=10000)
    expected: str = Field(default="", max_length=10000)


class Variant(Schema):
    key: str = Field(default_factory=lambda: str(uuid4()), min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=240)
    polarity: Literal["positive", "negative"]
    inputs: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    expected: str = Field(min_length=1, max_length=20000)
    notes: str = Field(default="", max_length=10000)
    enabled: bool = True
    steps_override: list[Step] | None = Field(default=None, max_length=100)

    @field_validator("steps_override")
    @classmethod
    def unique_override_keys(cls, steps: list[Step] | None) -> list[Step] | None:
        if steps is not None and len({step.key for step in steps}) != len(steps):
            raise ValueError("Ключи шагов варианта должны быть уникальны")
        return steps


class SpecLink(Schema):
    specification_id: str
    revision_id: str | None = None


class AccountLink(Schema):
    account_id: str
    alias: str = Field(min_length=1, max_length=80)


class CaseContent(Schema):
    title: str = Field(min_length=1, max_length=240)
    goal: str = Field(default="", max_length=20000)
    preconditions: str = Field(default="", max_length=20000)
    cleanup: str = Field(default="", max_length=10000)
    priority: Literal["low", "normal", "high", "critical"] = "normal"
    tags: list[str] = Field(default_factory=list, max_length=30)
    platforms: list[str] = Field(default_factory=list, max_length=20)
    steps: list[Step] = Field(default_factory=list, max_length=100)
    variants: list[Variant] = Field(default_factory=list, max_length=200)
    specifications: list[SpecLink] = Field(default_factory=list, max_length=100)
    accounts: list[AccountLink] = Field(default_factory=list, max_length=30)

    @field_validator("steps", "variants")
    @classmethod
    def unique_keys(cls, values):
        if len({v.key for v in values}) != len(values):
            raise ValueError("Ключи строк должны быть уникальны")
        return values

    @field_validator("accounts")
    @classmethod
    def unique_accounts(cls, values):
        if len({v.alias for v in values}) != len(values) or len({v.account_id for v in values}) != len(
            values
        ):
            raise ValueError("Аккаунты и их псевдонимы должны быть уникальны")
        return values


class PlanItem(Schema):
    use_case_id: str
    version_policy: Literal["latest_published", "fixed_publication"] = "latest_published"
    publication_id: str | None = None
    variant_selection: Literal["all_enabled", "explicit"] = "all_enabled"
    variant_keys: list[str] = Field(default_factory=list, max_length=200)
    assignee_id: str | None = None


class PlanContent(Schema):
    title: str = Field(min_length=1, max_length=240)
    purpose: str = Field(default="", max_length=20000)
    items: list[PlanItem] = Field(default_factory=list, max_length=200)
    environment_id: str | None = None


class ProposalItem(Schema):
    action: Literal["note", "create_use_case", "update_use_case"] = "note"
    use_case_id: str | None = None
    base_revision_id: str | None = None
    folder_id: str | None = None
    content: CaseContent | None = None
    note: str = Field(default="", max_length=20000)


class ProposalContent(Schema):
    description: str = Field(min_length=1, max_length=30000)
    items: list[ProposalItem] = Field(default_factory=list, max_length=100)
    repository: str = Field(default="", max_length=500)
    commit_sha: str = Field(default="", max_length=64)
    pull_request_url: str = Field(default="", max_length=1000)
    diff_fingerprint: str = Field(default="", max_length=128)
    impact: Literal["behavior_changed", "no_behavior_change", "unknown"] = "unknown"


class Anchor(Schema):
    revision_id: str
    field_path: str = Field(min_length=1, max_length=200)
    step_key: str | None = None
    variant_key: str | None = None
    quote: str = Field(default="", max_length=2000)
    prefix: str = Field(default="", max_length=200)
    suffix: str = Field(default="", max_length=200)

"""The published product documentation must cover the maintained operation surface."""

import json
from pathlib import Path

from app.operations import REGISTRY
from app.schemas import CaseContent


def test_quality_catalog_is_executable_and_covers_every_operation():
    catalog = json.loads((Path(__file__).resolve().parents[3] / "docs/qa/catalog.json").read_text())
    specs = {spec["key"] for spec in catalog["specifications"]}
    assert len(specs) == len(catalog["specifications"])
    assert all(
        spec["description"].strip() and spec["acceptance_criteria"].strip()
        for spec in catalog["specifications"]
    )
    keys, titles, operations = set(), set(), set()
    for entry in catalog["use_cases"]:
        content = CaseContent.model_validate(entry["content"])
        assert entry["catalog_key"] not in keys
        assert content.title not in titles
        keys.add(entry["catalog_key"])
        titles.add(content.title)
        assert entry["spec_keys"] and set(entry["spec_keys"]) <= specs
        assert content.goal.strip() and content.preconditions.strip() and content.cleanup.strip()
        assert content.steps and all(step.expected.strip() for step in content.steps)
        assert content.variants and all(variant.enabled for variant in content.variants)
        assert {variant.polarity for variant in content.variants} == {"positive", "negative"}
        assert set(entry["operations"]) <= set(REGISTRY)
        operations.update(entry["operations"])
    assert operations == set(REGISTRY)
    assert any(entry["smoke"] for entry in catalog["use_cases"])

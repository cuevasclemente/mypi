"""Dependency-free structural and privacy lint for this skill's canonical source."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTHORITATIVE_LICENSE = ROOT.parents[1] / "LICENSE"
REQUIRED_FILES = {
    "LICENSE",
    "SKILL.md",
    "references/METHOD.md",
    "assets/COMPARISON-ROUND.md",
    "assets/REVEAL-AND-CORRECTION.md",
    "assets/CONFOUND-LOG.md",
    "assets/REPLICATION-AND-TRANSFER.md",
    "assets/PHOTO-BOUNDARIES.md",
}
REQUIRED_CONCEPTS = {
    "controlled comparison": r"controlled (?:visual )?comparison",
    "admire judgment": r"\badmire\b",
    "inhabit judgment": r"\binhabit\b",
    "delayed reveal": r"delay(?:ed)? (?:the )?reveal|delayed metadata",
    "confound logging": r"confound log",
    "evidence layer": r"\bevidence\b",
    "interpretation layer": r"\binterpretation\b",
    "preference layer": r"\bpreference\b",
    "correction history": r"correction (?:history|protocol)",
    "social-safety context": r"social-safety",
    "replication": r"\breplicat(?:e|ed|ion)",
    "existing-wardrobe transfer": r"existing[- ]wardrobe",
    "photo privacy": r"photo and privacy|photo, storage, sharing",
}
PRIVACY_PATTERNS = {
    "absolute user path": re.compile(r"(?:^|[\s('`\"])(?:/home/|/Users/|[A-Za-z]:\\Users\\)"),
    "file URI": re.compile(r"\bfile://", re.IGNORECASE),
    "email address": re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
    "IPv4 address": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    "embedded data": re.compile(r"\bdata:(?:image|application)/", re.IGNORECASE),
    "remote Markdown image": re.compile(r"!\[[^]]*]\(https?://", re.IGNORECASE),
    "HTML image": re.compile(r"<img\b", re.IGNORECASE),
}


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        raise ValueError("SKILL.md must start with YAML frontmatter")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError("SKILL.md frontmatter is not closed")
    fields: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if not line.strip():
            continue
        if ":" not in line:
            raise ValueError(f"invalid frontmatter line: {line!r}")
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()
    return fields, text[end + 5 :]


def main() -> int:
    errors: list[str] = []

    missing = sorted(path for path in REQUIRED_FILES if not (ROOT / path).is_file())
    if missing:
        errors.append("missing required files: " + ", ".join(missing))

    markdown: dict[Path, str] = {}
    for path in sorted(ROOT.rglob("*")):
        if path.is_symlink():
            errors.append(f"symlink is not allowed: {path.relative_to(ROOT)}")
        if not path.is_file() or path.suffix != ".md":
            continue
        try:
            markdown[path] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            errors.append(f"non-UTF-8 Markdown: {path.relative_to(ROOT)}")

    skill_path = ROOT / "SKILL.md"
    if skill_path in markdown:
        try:
            fields, _ = parse_frontmatter(markdown[skill_path])
        except ValueError as exc:
            errors.append(str(exc))
            fields = {}
        expected_name = ROOT.name
        if fields.get("name") != expected_name:
            errors.append("frontmatter name must match the skill directory")
        description = fields.get("description", "")
        if not description:
            errors.append("frontmatter description is required")
        elif len(description) > 1024:
            errors.append("frontmatter description exceeds 1024 characters")
        if fields.get("license") != "MPL-2.0":
            errors.append("frontmatter license must be MPL-2.0")
        unexpected = sorted(set(fields) - {"name", "description", "license"})
        if unexpected:
            errors.append("unexpected frontmatter fields: " + ", ".join(unexpected))

    license_path = ROOT / "LICENSE"
    if license_path.is_file():
        license_bytes = license_path.read_bytes()
        if AUTHORITATIVE_LICENSE.is_file():
            if license_bytes != AUTHORITATIVE_LICENSE.read_bytes():
                errors.append("skill LICENSE does not match the authoritative repository LICENSE")
        else:
            try:
                license_text = license_bytes.decode("utf-8")
            except UnicodeDecodeError:
                errors.append("skill LICENSE is not UTF-8")
            else:
                required_mpl_markers = (
                    "Mozilla Public License Version 2.0",
                    "1. Definitions",
                    "10. Versions of the License",
                    "Exhibit A - Source Code Form License Notice",
                )
                if len(license_bytes) < 10_000 or any(marker not in license_text for marker in required_mpl_markers):
                    errors.append("skill LICENSE does not contain the complete Mozilla Public License Version 2.0 text")

    combined = "\n".join(markdown.values()).lower()
    for label, pattern in REQUIRED_CONCEPTS.items():
        if not re.search(pattern, combined, re.IGNORECASE):
            errors.append(f"required concept not found: {label}")

    for path, text in markdown.items():
        relative = path.relative_to(ROOT)
        for label, pattern in PRIVACY_PATTERNS.items():
            if pattern.search(text):
                errors.append(f"{relative}: possible {label}")
        for target in re.findall(r"\[[^]]+]\(([^)]+)\)", text):
            target = target.split("#", 1)[0]
            if not target or re.match(r"^[a-z]+://", target, re.IGNORECASE):
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(ROOT.resolve())
            except ValueError:
                errors.append(f"{relative}: link escapes skill directory: {target}")
                continue
            if not resolved.exists():
                errors.append(f"{relative}: broken relative link: {target}")

    disallowed = []
    for path in ROOT.rglob("*"):
        if (
            path.is_file()
            and path != license_path
            and path.suffix.lower() not in {".md", ".py"}
        ):
            disallowed.append(str(path.relative_to(ROOT)))
    if disallowed:
        errors.append("unexpected non-Markdown/non-test files: " + ", ".join(sorted(disallowed)))

    if errors:
        print("Validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"Validation passed: {len(markdown)} Markdown files checked.")
    print("Structure, required method concepts, relative links, and generic privacy patterns passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

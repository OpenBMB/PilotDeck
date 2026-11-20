import tempfile
import unittest
from pathlib import Path

import yaml

from utils import parse_skill_md


class ParseSkillMdTests(unittest.TestCase):
    def test_folded_description_matches_yaml(self):
        frontmatter = 'name: example\ndescription: >\n  First paragraph.\n\n  Second paragraph.\n'
        with tempfile.TemporaryDirectory() as directory:
            content = f"---\n{frontmatter}---\n# Body\n"
            (Path(directory) / "SKILL.md").write_text(content, encoding="utf-8")
            name, description, full_content = parse_skill_md(Path(directory))

        self.assertEqual(name, "example")
        self.assertEqual(description, yaml.safe_load(frontmatter)["description"])
        self.assertEqual(full_content, content)

    def test_quoted_inline_description_matches_yaml(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "SKILL.md").write_text(
                '---\nname: example\ndescription: "A: quoted value"\n---\n# Body\n',
                encoding="utf-8",
            )
            self.assertEqual(parse_skill_md(Path(directory))[1], "A: quoted value")

    def test_literal_description_matches_yaml(self):
        frontmatter = 'name: example\ndescription: |\n  First line.\n  Second line.\n'
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "SKILL.md").write_text(f"---\n{frontmatter}---\n", encoding="utf-8")
            self.assertEqual(parse_skill_md(Path(directory))[1], yaml.safe_load(frontmatter)["description"])


if __name__ == "__main__":
    unittest.main()

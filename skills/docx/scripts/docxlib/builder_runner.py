from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

from .builder import BuildContext


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--builder", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--input")
    args = parser.parse_args()

    builder_path = Path(args.builder).expanduser().resolve()
    specification = importlib.util.spec_from_file_location("pilotdeck_docx_builder", builder_path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Could not load builder: {builder_path}")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    build = getattr(module, "build", None)
    if not callable(build):
        raise RuntimeError("The builder must define build(context)")
    context = BuildContext(
        input_path=Path(args.input).expanduser().resolve() if args.input else None,
        output_path=Path(args.out).expanduser().resolve(),
    )
    build(context)
    if not context.output_path.is_file():
        raise RuntimeError("The builder did not call context.save(document)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

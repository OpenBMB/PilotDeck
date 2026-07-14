from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    parser = argparse.ArgumentParser(
        prog="og",
        description="og — Outline Graph framework (Framework A, PilotDeck 集成版)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m og run a --cluster DR-28
  python -m og run a --cluster DR-28 --curation --rewrite --balanced --polish
""",
    )

    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    sub.required = True


    run_p = sub.add_parser("run", help="Generate reports via Framework A (OG pipeline)")
    run_sub = run_p.add_subparsers(dest="framework", metavar="FRAMEWORK")
    run_sub.required = True

    from og.cli.run import add_run_a_args
    add_run_a_args(run_sub.add_parser("a", help="Framework A — OG pipeline"))

    args = parser.parse_args(argv)

    if args.command == "run":
        from og.cli.run import dispatch_run
        return dispatch_run(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())

"""Command-line interface for the node availability scanner."""

from __future__ import annotations

import argparse
import getpass
import logging
import sys

from ..config import AccountConfig, ScannerConfig, load_config
from ..core.models import WeightPreset
from ..scanner import NodeScanner


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ihpc-scan",
        description="Scan iHPC nodes and rank by availability.",
    )

    auth = p.add_argument_group("authentication")
    auth.add_argument(
        "-a", "--account",
        metavar="NAME",
        help="Account name from config.yaml (default: use default_account)",
    )
    auth.add_argument(
        "--all-accounts",
        action="store_true",
        help="Scan using ALL configured accounts and merge results",
    )
    auth.add_argument(
        "-u", "--user",
        help="Override username (skip config.yaml lookup)",
    )
    auth.add_argument(
        "-i", "--identity",
        metavar="KEY",
        help="Path to SSH private key file",
    )
    auth.add_argument(
        "--config",
        metavar="PATH",
        help="Path to config.yaml (default: auto-detect)",
    )

    out = p.add_argument_group("output")
    out.add_argument(
        "-f", "--format",
        choices=["table", "json", "csv"],
        default="table",
        help="Output format (default: table)",
    )
    out.add_argument(
        "--force",
        action="store_true",
        help="Bypass cache and force a fresh scan",
    )

    filt = p.add_argument_group("filters")
    filt.add_argument(
        "-c", "--cluster",
        help="Only show nodes from this cluster (e.g. mars, venus)",
    )
    filt.add_argument(
        "--min-score",
        type=float,
        metavar="N",
        help="Only show nodes with idle score >= N",
    )
    filt.add_argument(
        "--idle-gpu",
        action="store_true",
        help="Only show nodes with GPU utilisation < 10%% (likely idle)",
    )

    weight = p.add_argument_group("scoring weights")
    weight.add_argument(
        "-w", "--weights",
        choices=["gpu", "cpu", "balanced"],
        default=None,
        help="Weight preset (overrides config.yaml)",
    )
    weight.add_argument(
        "--custom-weights",
        metavar="CPU,MEM,GPU,USER",
        help="Custom weights as four comma-separated floats",
    )

    p.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging",
    )

    return p


def _parse_custom_weights(
    raw: str,
    parser: argparse.ArgumentParser,
) -> dict[str, float]:
    parts = raw.split(",")
    if len(parts) != 4:
        parser.error("--custom-weights requires exactly 4 comma-separated floats")
    try:
        vals = [float(x) for x in parts]
    except ValueError:
        parser.error("--custom-weights values must be numbers")
    return {"cpu": vals[0], "mem": vals[1], "gpu": vals[2], "user": vals[3]}


def _build_config(args: argparse.Namespace, parser: argparse.ArgumentParser) -> ScannerConfig:
    """Build ScannerConfig from CLI args, with YAML fallback."""
    if args.user:
        password: str | None = None
        if not args.identity:
            password = getpass.getpass("iHPC password: ")
        account = AccountConfig(
            name="cli",
            username=args.user,
            password=password,
            key_filename=args.identity,
        )
        config = ScannerConfig(accounts=[account], default_account="cli")
    else:
        try:
            config = load_config(args.config)
        except FileNotFoundError as exc:
            parser.error(str(exc))

    if args.weights:
        preset_map = {"gpu": WeightPreset.GPU_HEAVY, "cpu": WeightPreset.CPU_HEAVY, "balanced": WeightPreset.BALANCED}
        config.weight_preset = preset_map[args.weights]
        config.custom_weights = None

    if args.custom_weights:
        config.custom_weights = _parse_custom_weights(args.custom_weights, parser)

    return config


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("paramiko").setLevel(logging.WARNING)

    config = _build_config(args, parser)

    display_kwargs = dict(
        fmt=args.format,
        cluster=args.cluster,
        min_score=args.min_score,
        require_idle_gpu=args.idle_gpu,
    )

    scanner = NodeScanner(config)

    if args.all_accounts:
        _scan_all_accounts(scanner, config, args.force, display_kwargs)
    else:
        account_name = args.account or config.default_account or None
        try:
            result = scanner.scan(account_name=account_name, force=args.force)
        except Exception as exc:
            logging.error("Scan failed: %s", exc)
            sys.exit(1)
        print(scanner.display(result, **display_kwargs))


def _scan_all_accounts(
    scanner: NodeScanner,
    config: ScannerConfig,
    force: bool,
    display_kwargs: dict,
) -> None:
    """Scan with every configured account and print results grouped."""
    outputs: list[str] = []
    for acct in config.accounts:
        try:
            result = scanner.scan(account_name=acct.name, force=force)
            outputs.append(scanner.display(result, **display_kwargs))
        except Exception as exc:
            logging.error("Scan failed for account '%s': %s", acct.name, exc)
            outputs.append(f"Account: {acct.name}\n  Scan failed: {exc}\n")

    print("\n\n".join(outputs))


if __name__ == "__main__":
    main()

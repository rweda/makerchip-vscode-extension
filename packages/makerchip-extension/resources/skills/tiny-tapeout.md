---
name: tiny-tapeout
description: 'Set up and run a Tiny Tapeout (TT) chip project in TL-Verilog with Makerchip, building it on GitHub Actions. Use when: Tiny Tapeout, TT, tapeout, taping out a design, making a chip/ASIC/GDS from TL-Verilog, a ttXX-makerchip-template repo, the "Run TT Flow" button, or TT GitHub Actions results (GDS, precheck, gate-level test, 3D viewer).'
user-invocable: true
---

# Tiny Tapeout with Makerchip

A TT project is a GitHub repo made from
[stevehoover/ttsky-makerchip-template](https://github.com/stevehoover/ttsky-makerchip-template) (SKY130). The
design is `src/project.tlv`; `src/project.sv` is generated from it and committed, and pushing runs TT's flow
(`gds`, `test`, `docs` workflows) on GitHub Actions. The template README covers the project files.

Your job is the one-time setup. After it, the user runs the flow with the "Run TT Flow" button, without you.

## Setup

1. **GitHub CLI.** `gh auth status`. If not logged in, ask the user to run `gh auth login` (it needs them to
   confirm a code in their browser).
2. **Create the repo** (public; TT requires it) inside a folder open in VS Code:
   `gh repo create <name> --template stevehoover/ttsky-makerchip-template --public --clone`.
3. **Enable GitHub Pages** right away (TT's `viewer` job deploys to it):
   `gh api -X POST repos/<owner>/<name>/pages -f build_type=workflow`.
4. **Personalize** (the template holds `PLACEHOLDER` values that pass TT's checks; replace all of them):
   - `info.yaml`: `title`, `author`, `description`, `pinout`, and `top_module`, named
     `tt_um_<github-username>_<project>`. Use the same name for `my_design` in `src/project.tlv` and the module
     instantiated in `test/tb.v`.
   - `docs/info.md`: "How it works" and "How to test".
5. **Add the button:** open `src/project.tlv` in an editor (so VS Code's Git support sees the repo), then call
   `makerchip_tt_enable` with its absolute path (enable the `tinytapeout` tools, or use `makerchip_invoke_tool`).
6. **First run:** ask the user to click "Run TT Flow" in the editor title bar. It compiles in Makerchip,
   regenerates `src/project.sv` with SandPiper-SaaS, asks for a commit message, commits, and pushes. It also
   commits anything else already staged, after asking.

## Watching a run

The button only pushes; results are on GitHub until Makerchip's TT views exist.

- `gh run list -R <owner>/<name>`, `gh run watch <id> -R <owner>/<name> --exit-status`.
- Failures: `gh run view <id> -R <owner>/<name> --log-failed`. The first failing step is the cause; TT's summary
  steps (e.g. "Linter output") then fail too, for lack of output.
- Results: `https://<owner>.github.io/<name>/` (redirects to TT's 3D viewer) and `gds_render.png` beside it.
  Artifacts (`tt_submission`, `GDS_logs`, `precheck_reports`, `gatelevel_test_results`, ...):
  `gh run download <id> -R <owner>/<name> -n <artifact>`.

## Notes

- Without the button, the same compile is `cd test && make verilog` (needs `pipx install sandpiper-saas`); commit
  `src/project.sv` with the `.tlv`.
- Makerchip compiles of `project.tlv` define `MAKERCHIP`, which adds the TT demo-board VIZ and random stimulus;
  the TT compile does not, so the pushed Verilog contains only the design.
- Submitting to a shuttle happens at [app.tinytapeout.com](https://app.tinytapeout.com), not here.

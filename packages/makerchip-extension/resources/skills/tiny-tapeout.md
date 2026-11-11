---
name: tiny-tapeout
description: 'Set up and run a Tiny Tapeout (TT) chip project in TL-Verilog with Makerchip, building it on GitHub Actions. Use when: Tiny Tapeout, TT, tapeout, taping out a design, making a chip/ASIC/GDS from TL-Verilog, a ttXX-makerchip-template repo, the "Run TT Flow" button, or TT GitHub Actions results (GDS, precheck, gate-level test, 3D viewer).'
user-invocable: true
---

# Tiny Tapeout with Makerchip

A TT project is a GitHub repo made from
[stevehoover/tt-makerchip-template](https://github.com/stevehoover/tt-makerchip-template) (any TT process;
`project.pdk` in `info.yaml`). The design is `src/project.tlv`; `src/project.sv` is generated from it and
committed, and pushing runs TT's flow (`gds`, `test`, `docs` workflows) on GitHub Actions. The template README
covers the project files. (A reference copy of the repo is in
[resources/tt-makerchip-template/](../../resources/tt-makerchip-template/), but the one on GitHub may be newer).

Your job is the one-time setup. After it, the user runs the flow with the "Run TT Flow" button, without you.

## Setup

1. **GitHub CLI.** `gh auth status`. If `gh` is missing, offer to install it (https://cli.github.com/). If not
   logged in, ask the user to run `gh auth login` (it needs them to confirm a code in their browser).
2. **Create the repo** (public; TT requires it). First ask the user, suggesting defaults:
   - its name (e.g. from their project idea) and owner: their account (`gh api user --jq .login`) or an
     organization they belong to;
   - where to clone it: suggest a new folder beside their current projects, never inside another Git repo
     (check with `git -C <parent> rev-parse --is-inside-work-tree`).

   Then, from the chosen parent folder:
   `gh repo create <owner>/<name> --template stevehoover/tt-makerchip-template --public --clone`. Its initial
   commit already runs the flow once; with the template's blank project info, `gds` and `docs` fail (expected).
   Offer to open the clone in VS Code (add it to the current workspace, or `code <dir>` for a new window).
3. **Enable GitHub Pages** right away (TT's `viewer` job deploys to it, after `gds`):
   `gh api -X POST repos/<owner>/<name>/pages -f build_type=workflow`.
4. **Personalize.** Like Tiny Tapeout's own templates, this one leaves the project's identity and docs blank,
   and TT's checks fail the `gds` and `docs` runs until they are filled. TT wants a person to supply them, so
   ask the user; never invent them or fill in placeholders.
   - Now: `info.yaml` `pdk`, the process of the shuttle they're targeting (`sky130A`, `gf180mcuD`,
     `ihp-sg13cmos5l` or `ihp-sg13g2`; open shuttles and their processes are at https://tinytapeout.com/chips/,
     and the default is `sky130A`); `title`, `author`, `description` (`gds` fails without them); and `top_module`,
     named `tt_um_<github-username>_<project>`. Use the same name for `my_design` in `src/project.tlv` and the
     module instantiated in `test/tb.v`.
   - As the design takes shape (from the user's answers, or drafts they approve): `info.yaml` `pinout` (at
     least one entry) and `docs/info.md`'s "How it works" and "How to test" sections (`docs` fails without
     them), and the testbench `test/test.py` (its check of the template's all-zero outputs fails once the
     design drives them). So setup alone does not make every run pass; tell the user what remains.
   - Stage these edits (`git add`) without committing; the button's commit includes them (after asking).
5. **Show the user the buttons:** open `src/project.tlv` in an editor. Its title bar has the Makerchip button and,
   because the file is in `src/` of a project with `info.yaml`, a "Run TT Flow" button. Describe both briefly,
   e.g. "The Makerchip button compiles and simulates your design. The rocket next to it runs the Tiny Tapeout
   flow: it checks for missing project information (`info.yaml` and `docs/info.md`), compiles in Makerchip,
   regenerates `src/project.sv` (with SandPiper-SaaS), asks for a commit message, commits (asking first if
   other files, such as the ones I edited for you, are staged), and pushes."

## Watching a run

After pushing, the button opens (or reuses) two Makerchip views, whose tab status follows the run: **TT
Progress** (runs, jobs, and current steps, polled anonymously from the GitHub API) and **TT Layout** (the
render, TT's 3D viewer, and Tiny Tapeout Explorer, from the repo's GitHub Pages). For the status as data, call
`getRunStatus` on TT Progress with `makerchip_view_call`. More detail is on GitHub:

- `gh run list -R <owner>/<name>`, `gh run watch <id> -R <owner>/<name> --exit-status`.
- Failures: `gh run view <id> -R <owner>/<name> --log-failed`. The first failing step is the cause; TT's summary
  steps (e.g. "Linter output") then fail too, for lack of output.
- Results: `https://<owner>.github.io/<name>/` (redirects to TT's 3D viewer) and `gds_render.png` beside it.
  Artifacts (`tt_submission`, `GDS_logs`, `precheck_reports`, `gatelevel_test_results`, ...):
  `gh run download <id> -R <owner>/<name> -n <artifact>`.

## Notes

- The design is `src/project.tlv`. `src/project.sv` is generated from it and committed; never edit it by hand.
  Without the button, regenerate it with `cd test && make verilog` (needs `pipx install sandpiper-saas`) and
  commit it with the `.tlv`.
- Makerchip compiles of `project.tlv` define `MAKERCHIP`, which adds the TT demo-board VIZ and random stimulus;
  the TT compile does not, so the pushed Verilog contains only the design.
- To retarget another shuttle's process, change `project.pdk` in `info.yaml` (and check that `tiles` is valid for
  it: `tech/<pdk>/tile_sizes.yaml` in TinyTapeout/tt-support-tools), then run the flow again. TT's app rejects a
  submission hardened for a different PDK than the shuttle's.
- Missing project info (step 4) fails `gds` at "Fetch verilog and build config" and `docs` with "Errors in
  info.yaml"/"docs/info.md". Each build's tool and PDK versions are in its `tt_submission` artifact's `pdk.json`.
- **Seeing the design's VIZ.** In Makerchip, the design's `\viz_js` is drawn in the demo board's small, square
  chip window, so a whole-board `makerchip_get_viz_image` is too small to read. Zoom in with a one-frame
  `makerchip_capture_video` in `absolute` mode. The window is `BOARD_7_FPGA_WHERE` (in board-image pixels) in
  Virtual-FPGA-Lab's `tlv_lib/fpga_includes.tlv`, at the commit included by the `tiny_tapeout_lib.tlv` that
  `src/project.tlv` includes (follow the pinned `m4_include_lib` URLs; the resources copy of Virtual-FPGA-Lab is
  newer and may differ).
- Submitting to a shuttle happens at [app.tinytapeout.com](https://app.tinytapeout.com), not here.
- The template's own `tt-makerchip-template-dev` skill is for maintaining the template, not for projects.

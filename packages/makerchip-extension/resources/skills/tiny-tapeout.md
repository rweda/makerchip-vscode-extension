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
2. **Create the repo** (public; TT requires it):
   `gh repo create <name> --template stevehoover/ttsky-makerchip-template --public --clone`.
   Its initial commit already runs the flow once; with the template's blank project info, `gds` and `docs` fail
   (expected).
3. **Enable GitHub Pages** right away (TT's `viewer` job deploys to it, after `gds`):
   `gh api -X POST repos/<owner>/<name>/pages -f build_type=workflow`.
4. **Personalize.** Like Tiny Tapeout's own templates, this one leaves the project's identity and docs blank,
   and TT's checks fail the `gds` and `docs` runs until they are filled. TT wants a person to supply them, so
   ask the user; never invent them or fill in placeholders.
   - Now: `info.yaml` `title`, `author`, `description`, and `top_module`, named
     `tt_um_<github-username>_<project>`. Use the same name for `my_design` in `src/project.tlv` and the module
     instantiated in `test/tb.v`.
   - As the design takes shape (from the user's answers, or drafts they approve): `info.yaml` `pinout` (at
     least one entry) and `docs/info.md`'s "How it works" and "How to test" sections.
   - Stage these edits (`git add`) without committing; the button's commit includes them (after asking).
5. **Add the button:** call `makerchip_tt_enable` with the absolute path of `src/project.tlv` (enable the
   `tinytapeout` tools, or use `makerchip_invoke_tool`). Open the file in an editor for the user. Point
   out to the user its Makerchip button as well as this "Run TT Flow" button in the editor title bar, and
   describe their behavior briefly. E.g. "The Makerchip button in the `project.tlv` editor panel's title bar
   runs compilation/simulation. The TT button next to it
   runs the Tiny Tapeout flow: checks for and names any missing data (`info.yaml` and `docs/info.md`), if
   everything is present, compiles/simulates in Makerchip, regenerates `src/project.sv` (with
   SandPiper-SaaS), asks for a commit message, commits (asking first if other files, such as those I
   configured for you, have been staged), and pushes."

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

- Without the button, the same compile is `cd test && make verilog` (needs `pipx install sandpiper-saas`); commit
  `src/project.sv` with the `.tlv`.
- Makerchip compiles of `project.tlv` define `MAKERCHIP`, which adds the TT demo-board VIZ and random stimulus;
  the TT compile does not, so the pushed Verilog contains only the design.
- Submitting to a shuttle happens at [app.tinytapeout.com](https://app.tinytapeout.com), not here.

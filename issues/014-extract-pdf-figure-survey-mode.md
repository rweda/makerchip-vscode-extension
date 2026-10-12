# 014: `makerchip_extract_pdf_figure` has no cheap way to survey a document

- Status: open
- Area: `makerchip_extract_pdf_figure` tool
- Created: 2026-10-12

When the user gives only a URL, the first job is to find a figure worth animating. The tool
has no compact output, so a survey is expensive:

- Page 1 of a 6-slides-per-page lecture handout with the default `largest` gave 625 KB, even with
  path `d` strings omitted: 2202 primitives and 174 labels. A filled page-background rectangle
  joins everything into one cluster, so "largest" is the whole page.
- The workaround was a 1×1 `region` with `text: "all"` to get only the labels, then `jq` over
  the spill file.

Remaining work (some combination):

- Add a `summary` output mode. It would give counts plus cluster bboxes and sizes, and label text
  grouped by line. That is enough to choose a figure and a `region` without the full pools.
- Consider leaving out the background rectangle, or dropping a primitive that covers ≥ ~90% of
  the page before clustering.

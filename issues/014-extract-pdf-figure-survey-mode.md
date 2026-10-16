# 014: `makerchip_extract_pdf_figure` has no cheap way to survey a document

- Status: open
- Area: `makerchip_extract_pdf_figure` tool
- Created: 2026-10-12

When the user gives only a URL, the first job is to find a figure worth animating. `summary`
with `select: {mode: "all"}` now surveys the page (clusters, image boxes, text lines; see the
`summary` schema description), and `PdfExtractor`'s clustering leaves out page-covering
primitives (see `clusterPrimitives`).

Remaining work:

- Verify live on page 1 of a 6-slides-per-page lecture handout (previously 625 KB by default:
  2202 primitives, 174 labels, one page-sized cluster from a background rect): the survey should
  be compact, the slides should be separate clusters, and `lines` should read sensibly. Then
  close this issue.

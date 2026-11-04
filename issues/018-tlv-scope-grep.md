# 018: Scope-aware grep for `.tlv` files (CLI + LM tool)

- Status: open
- Area: LM tools / TL-Verilog
- Created: 2026-11-03

Plain `grep` on TL-Verilog returns matched lines without their meaning: `$valid = ...` says little
without knowing it sits in `/core|fetch@1`. TL-Verilog scope is indentation-based, so the enclosing
scope of a line is recoverable cheaply.

Create a grep-like executable and a matching LM tool (one shared implementation) that, for each
match, prints the ancestor scope lines before the matched line -- each preceding line with less
indentation than the last one shown (`\TLV`, `/hier`, `|pipe`, `@stage`, `?$when`, macro
instantiations, ...), with line numbers -- deduplicating ancestors shared by consecutive matches.

Remaining decisions:
- Package/location (`tlv-extension` vs. `makerchip-extension`) and how the executable is exposed.
- Handling of regions not governed by TLV indentation (`\SV`, `\SV_plus`, M4 macro bodies).
- Options worth supporting beyond pattern and file(s) (e.g. regex flags, `-A` trailing context).

# Advanced List View Customizer (Odoo 19)

**Author:** Mohamed Anwar
**Depends:** `base`, `web`

Adds spreadsheet-like power to *every* Odoo list (tree) view via a JavaScript
patch layered on top of the standard `ListRenderer` — no need to touch
existing view XML.

## Features

| Feature | How it works |
|---|---|
| **Multi-cell selection** | Click a cell then drag, or Shift+Click to extend a rectangular range across rows/columns. |
| **Inline bulk editing** | `Ctrl/Cmd+C` copies the selected block as TSV; `Ctrl/Cmd+V` pastes it back starting at the anchor cell, updating every affected record; `Delete`/`Backspace` clears the selection. |
| **Drag-to-fill** | Grab the small purple handle at the bottom-right of a selection and drag down to replicate/repeat the selected rows' values into the rows below, spreadsheet-style. |
| **Column freezing** | Toolbar → *Freeze* lets you pin the first N columns so they stay visible while scrolling a wide list horizontally (`position: sticky`). |
| **Calculated columns** | Toolbar → *Calculated Column* adds a virtual, read-only column computed live from a simple arithmetic formula over the row's already-loaded field values (e.g. `(price_unit * product_uom_qty) - discount`). Nothing is written to the database. |
| **Per-user saved layouts** | Toolbar → *Save Layout* / *Load Layout* persist frozen-column count + calculated columns (and optionally your default layout for that model) to the new `list.view.custom.config` model, per user, with an option to share with everyone. |

## Installation

1. Copy the `advanced_list_view_customizer` folder into your Odoo 19
   `addons` path (or a custom addons repo mounted alongside it).
2. Restart the Odoo server with `-u advanced_list_view_customizer` (or
   update the apps list and install it from the Apps menu).
3. Open any list view — the spreadsheet toolbar appears above the table.

No extra Python dependencies are required.

## Module layout

```
advanced_list_view_customizer/
├── __manifest__.py
├── models/
│   ├── list_view_custom_config.py   # saved per-user layouts
│   └── list_calculated_column.py    # formula columns attached to a layout
├── security/
│   ├── ir.model.access.csv
│   └── list_view_security.xml       # own-or-shared record rules
├── views/                           # admin screens under Settings ▸ Technical ▸ List Customizer
└── static/src/
    ├── js/
    │   ├── list_renderer_patch.js       # the core: selection, fill, freeze, calc columns, save/load
    │   ├── utils/
    │   │   ├── safe_formula_evaluator.js  # hand-rolled arithmetic parser (no eval/Function)
    │   │   ├── cell_selection_manager.js  # tracks the (row, col) rectangle
    │   │   └── clipboard_utils.js         # TSV <-> 2D array helpers
    │   └── components/                    # OWL dialogs: save/load/freeze/calculated column
    ├── xml/
    │   ├── list_renderer_toolbar.xml      # t-inherit of web.ListRenderer, adds the toolbar
    │   └── dialogs_templates.xml
    └── scss/list_view_customizer.scss
```

## Security model

* `list.view.custom.config` and `list.calculated.column` are readable/
  writable by any internal user (`base.group_user`), but a record rule
  restricts visibility to the owner **or** layouts explicitly marked
  `shared = True`.
* Only the owner (or an Administrator/System user) can update or delete a
  saved layout — enforced both by the record rule and inside
  `save_view_config` / `delete_view_config`.
* Calculated-column formulas are validated **twice**: once client-side
  (a restricted recursive-descent parser, see `safe_formula_evaluator.js`)
  before they're ever evaluated against loaded records, and again
  server-side (`_check_formula_safety`, AST whitelist) before being
  persisted — no `eval()`, no `Function()`, no arbitrary code execution.

## Known limitations / things to double check on your exact Odoo 19 build

Odoo's internal JS module paths are usually stable across minor versions
but *can* shift. If something doesn't wire up after installing:

* `list_renderer_patch.js` imports `ListRenderer` from
  `@web/views/list/list_renderer`. If your build renamed or split this
  file (e.g. separate desktop/mobile renderers), update the import and
  re-check `this.tableRef` — the patch assumes the base component exposes
  a `useRef("table")` reference to the `<table class="o_list_table">`
  element (true in Odoo 17/18; verify for 19).
* `list_renderer_toolbar.xml` inherits the `web.ListRenderer` QWeb
  template with `t-inherit-mode="extension"` and an xpath targeting
  `//table[hasclass('o_list_table')]`. If that template was renamed or
  restructured, adjust the xpath expression — the browser console will
  show an "could not find xpath target" style warning if it fails to
  apply, without blocking the rest of the app.
* Bulk paste only supports simple value fields (char, text, integer,
  float, monetary, boolean, date/datetime). Relational and selection
  fields are intentionally skipped (a notification explains why) since
  resolving a pasted display label to the correct id safely needs extra
  server round-trips that are out of scope here.
* Drag-to-fill currently fills **downward** only (the common spreadsheet
  case); horizontal fill can be added the same way if needed.
* Grouped list views (with expandable group headers) aren't specifically
  accounted for in the row-index math; the features are built and tested
  against flat (ungrouped) list views. Selection/fill on a grouped list
  may behave unpredictably until this is extended.
* Frozen columns use `position: sticky`, which requires the list's
  horizontal scroll container to actually allow horizontal scrolling
  (this is the default for wide lists in Odoo's standard layout).

## Extending it

* Add more formula operators/functions in `safe_formula_evaluator.js`
  (keep the whitelist mirrored in `list_calculated_column.py`).
* Add column *reordering* and per-column pixel-width persistence by
  hooking into the existing `column_config` JSON blob saved on
  `list.view.custom.config` — the storage and load/save plumbing is
  already in place, only the drag-to-reorder UI is left to add.

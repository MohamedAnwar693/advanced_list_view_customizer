/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import {
    onMounted,
    onPatched,
    onWillUnmount,
    useState,
} from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ListRenderer } from "@web/views/list/list_renderer";

import { CellSelectionManager } from "./utils/cell_selection_manager";
import { gridToTsv, tsvToGrid } from "./utils/clipboard_utils";
import { compileFormula } from "./utils/safe_formula_evaluator";

import { SaveViewDialog } from "./components/save_view_dialog";
import { LoadViewDialog } from "./components/load_view_dialog";
import { CalculatedColumnDialog } from "./components/calculated_column_dialog";
import { FreezeColumnsDialog } from "./components/freeze_columns_dialog";


const NUMBER_FORMATTERS = {
    integer: (value) => Math.round(Number(value)).toLocaleString(),
    float: (value, precision) =>
        Number(value).toFixed(precision ?? 2),
    monetary: (value, precision) =>
        Number(value).toFixed(precision ?? 2),
    percentage: (value, precision) =>
        (Number(value) * 100).toFixed(precision ?? 2) + "%",
};


patch(ListRenderer.prototype, {
    setup() {
        super.setup();

        this.orm = useService("orm");
        this.dialog = useService("dialog");
        this.notification = useService("notification");

        this.alvcSelection = new CellSelectionManager();

        this.alvcState = useState({
            frozenColumnCount: 0,
            calculatedColumns: [],
            activeLayoutId: null,
            activeLayoutName: null,
        });

        this._alvcPendingFillRowMax = null;

        this._alvcOnMouseUp = this._alvcOnMouseUp.bind(this);
        this._alvcOnKeyDown = this._alvcOnKeyDown.bind(this);

        onMounted(async () => {
            await this._alvcLoadDefaultLayout();

            this._alvcSetupTable();

            window.addEventListener(
                "mouseup",
                this._alvcOnMouseUp
            );

            window.addEventListener(
                "keydown",
                this._alvcOnKeyDown
            );
        });

        onPatched(() => {
            this._alvcSetupTable();
        });

        onWillUnmount(() => {
            window.removeEventListener(
                "mouseup",
                this._alvcOnMouseUp
            );

            window.removeEventListener(
                "keydown",
                this._alvcOnKeyDown
            );
        });
    },

    // ================================================================
    // TABLE HELPERS
    // ================================================================
    _alvcGetTableEl() {
        if (this.el) {
            const table = this.el.matches("table.o_list_table")
                ? this.el
                : this.el.querySelector("table.o_list_table");

            if (table) {
                return table;
            }
        }

        return document.querySelector(
            "table.o_list_table"
        );
    },

    _alvcGetRecords() {
        return this.props.list?.records || [];
    },

    _alvcGetRealColumns() {
        const columns = this.props.list?.columns || [];

        return columns.filter(
            (column) => column.type === "field"
        );
    },

    // ================================================================
    // TABLE SETUP
    // ================================================================
    _alvcSetupTable() {
        const table = this._alvcGetTableEl();

        if (!table) {
            return;
        }
        this._alvcBindSelectionEvents(table);
        this._alvcApplyFrozenColumns(table);
        this._alvcRenderCalculatedColumns(table);
        this._alvcRenderSelectionHighlight(table);
    },

    _alvcBindSelectionEvents(table) {
        if (table.dataset.alvcBound === "1") {
            return;
        }

        table.dataset.alvcBound = "1";
        table.addEventListener(
            "mousedown",
            (event) => this._alvcOnCellMouseDown(event)
        );
        table.addEventListener(
            "mouseover",
            (event) => this._alvcOnCellMouseOver(event)
        );
    },

    // ================================================================
    // CELL RESOLUTION
    // ================================================================
    _alvcResolveCell(event) {
        const target = event.target;

        if (!(target instanceof Element)) {
            return null;
        }
        const td = target.closest("td");
        if (!td) {
            return null;
        }
        const tr = td.closest("tr");
        const tbody = tr?.closest("tbody");
        if (!tr || !tbody) {
            return null;
        }
        if (
            td.classList.contains("o_list_record_selector") ||
            td.classList.contains("o_handle_cell") ||
            td.classList.contains("o_list_record_open_form_view") ||
            td.classList.contains("o_alvc_calculated_cell")
        ) {
            return null;
        }
        const dataRows = Array.from(
            tbody.querySelectorAll(
                ":scope > tr.o_data_row"
            )
        );
        const rowIndex = dataRows.indexOf(tr);
        if (rowIndex === -1) {
            return null;
        }
        const cells = Array.from(
            tr.querySelectorAll(":scope > td")
        ).filter(
            (cell) =>
                !cell.classList.contains(
                    "o_list_record_selector"
                ) &&
                !cell.classList.contains(
                    "o_handle_cell"
                ) &&
                !cell.classList.contains(
                    "o_alvc_calculated_cell"
                )
        );
        const colIndex = cells.indexOf(td);
        if (colIndex === -1) {
            return null;
        }
        return {
            rowIndex,
            colIndex,
            td,
            tr,
        };
    },

    // ================================================================
    // MOUSE SELECTION
    // ================================================================
    _alvcOnCellMouseDown(event) {
        if (
            event.target.closest(
                ".o_alvc_fill_handle"
            )
        ) {
            return;
        }
        const cell = this._alvcResolveCell(event);
        if (!cell) {
            return;
        }
        if (
            event.shiftKey &&
            this.alvcSelection.hasSelection()
        ) {
            this.alvcSelection.extendTo(
                cell.rowIndex,
                cell.colIndex
            );
        } else {
            this.alvcSelection.start(
                cell.rowIndex,
                cell.colIndex
            );
        }
        this._alvcRenderSelectionHighlight(
            this._alvcGetTableEl()
        );
    },

    _alvcOnCellMouseOver(event) {
        if (!this.alvcSelection.isSelecting) {
            return;
        }
        const cell = this._alvcResolveCell(event);
        if (!cell) {
            return;
        }
        this.alvcSelection.extendTo(
            cell.rowIndex,
            cell.colIndex
        );
        this._alvcRenderSelectionHighlight(
            this._alvcGetTableEl()
        );
    },

    _alvcOnMouseUp() {
        if (this.alvcSelection.isSelecting) {
            this.alvcSelection.stop();
        }
    },

    // ================================================================
    // KEYBOARD
    // ================================================================
    _alvcOnKeyDown(event) {
        if (!this.alvcSelection.hasSelection()) {
            return;
        }
        const table = this._alvcGetTableEl();
        if (!table) {
            return;
        }
        const activeElement = document.activeElement;
        if (
            activeElement &&
            activeElement.tagName === "INPUT" &&
            !table.contains(activeElement)
        ) {
            return;
        }
        const key = event.key.toLowerCase();
        const isCopy =
            (event.ctrlKey || event.metaKey) &&
            key === "c";
        const isPaste =
            (event.ctrlKey || event.metaKey) &&
            key === "v";
        const isDelete =
            event.key === "Delete" ||
            event.key === "Backspace";
        if (isCopy) {
            event.preventDefault();
            this._alvcCopySelection();
        } else if (isPaste) {
            event.preventDefault();
            this._alvcPasteIntoSelection();
        } else if (isDelete) {
            event.preventDefault();
            this._alvcClearSelection();
        }
    },

    // ================================================================
    // COPY
    // ================================================================
    _alvcCopySelection() {
        const table = this._alvcGetTableEl();
        const bounds = this.alvcSelection.getBounds();
        if (!table || !bounds) {
            return;
        }
        const tbody = table.querySelector("tbody");
        if (!tbody) {
            return;
        }
        const rows = Array.from(
            tbody.querySelectorAll(
                ":scope > tr.o_data_row"
            )
        );
        const grid = [];
        for (
            let rowIndex = bounds.rowMin;
            rowIndex <= bounds.rowMax;
            rowIndex++
        ) {
            const tr = rows[rowIndex];

            if (!tr) {
                continue;
            }
            const cells = Array.from(
                tr.querySelectorAll(":scope > td")
            ).filter(
                (cell) =>
                    !cell.classList.contains(
                        "o_list_record_selector"
                    ) &&
                    !cell.classList.contains(
                        "o_handle_cell"
                    ) &&
                    !cell.classList.contains(
                        "o_alvc_calculated_cell"
                    )
            );
            const row = [];
            for (
                let colIndex = bounds.colMin;
                colIndex <= bounds.colMax;
                colIndex++
            ) {
                row.push(
                    cells[colIndex]
                        ? cells[colIndex].innerText.trim()
                        : ""
                );
            }
            grid.push(row);
        }
        const tsv = gridToTsv(grid);
        if (
            navigator.clipboard &&
            navigator.clipboard.writeText
        ) {
            navigator.clipboard
                .writeText(tsv)
                .catch(() => {});
        }
    },

    // ================================================================
    // PASTE
    // ================================================================
    async _alvcPasteIntoSelection() {
        if (
            !navigator.clipboard ||
            !navigator.clipboard.readText
        ) {
            this.notification.add(
                "Clipboard access isn't available in this browser context.",
                {
                    type: "warning",
                }
            );

            return;
        }
        let text;
        try {
            text =
                await navigator.clipboard.readText();
        } catch {
            this.notification.add(
                "Could not read from the clipboard. Please allow clipboard access.",
                {
                    type: "warning",
                }
            );
            return;
        }
        const grid = tsvToGrid(text);
        if (!grid.length) {
            return;
        }
        const anchor =
            this.alvcSelection.getAnchorCell() || {
                rowIndex: 0,
                colIndex: 0,
            };
        const columns =
            this._alvcGetRealColumns();
        const records =
            this._alvcGetRecords();
        let unsupportedFieldWarned = false;
        for (
            let rowIndex = 0;
            rowIndex < grid.length;
            rowIndex++
        ) {
            const record =
                records[
                    anchor.rowIndex + rowIndex
                ];

            if (!record) {
                break;
            }

            const rowValues = grid[rowIndex];
            const updates = {};

            for (
                let colIndex = 0;
                colIndex < rowValues.length;
                colIndex++
            ) {
                const column =
                    columns[
                        anchor.colIndex + colIndex
                    ];

                if (!column) {
                    continue;
                }
                const fieldDef =
                    record.fields?.[column.name];
                const value =
                    this._alvcCoerceValue(
                        rowValues[colIndex],
                        fieldDef
                    );
                if (value === undefined) {
                    unsupportedFieldWarned = true;
                    continue;
                }
                updates[column.name] = value;
            }
            if (!Object.keys(updates).length) {
                continue;
            }
            try {
                await record.update(updates);
            } catch (error) {
                console.error(
                    "Advanced List View Customizer: failed to update record",
                    error
                );
            }
        }
        try {
            const root =
                this.props.list?.model?.root;
            if (root?.save) {
                await root.save({
                    reload: false,
                });
            } else {
                for (const record of records) {
                    if (record.dirty && record.save) {
                        await record.save({
                            reload: false,
                        });
                    }
                }
            }
        } catch (error) {
            console.error(
                "Advanced List View Customizer: failed to save pasted values",
                error
            );
            this.notification.add(
                "Some pasted values could not be saved.",
                {
                    type: "danger",
                }
            );
        }
        if (unsupportedFieldWarned) {
            this.notification.add(
                "Some columns such as relational or selection fields were skipped.",
                {
                    type: "warning",
                }
            );
        }
    },

    // ================================================================
    // VALUE CONVERSION
    // ================================================================
    _alvcCoerceValue(text, fieldDef) {
        const type = fieldDef?.type;
        const trimmed = String(text ?? "").trim();
        switch (type) {
            case "integer":
                return trimmed === ""
                    ? false
                    : parseInt(trimmed, 10) || 0;

            case "float":
            case "monetary":
                return trimmed === ""
                    ? false
                    : parseFloat(
                        trimmed.replace(",", ".")
                    ) || 0;

            case "boolean":
                return [
                    "1",
                    "true",
                    "yes",
                    "y",
                ].includes(
                    trimmed.toLowerCase()
                );

            case "char":
            case "text":
                return trimmed;

            case "date":
            case "datetime":
                return trimmed;

            case "many2one":
            case "many2many":
            case "one2many":
            case "selection":
                return undefined;

            default:
                return trimmed;
        }
    },

    _alvcEmptyValueFor(fieldDef) {
        const type = fieldDef?.type;
        if (
            [
                "integer",
                "float",
                "monetary",
            ].includes(type)
        ) {
            return 0;
        }
        if (type === "boolean") {
            return false;
        }
        if (
            [
                "many2many",
                "one2many",
            ].includes(type)
        ) {
            return [[5, 0, 0]];
        }
        return false;
    },

    // ================================================================
    // DELETE / CLEAR
    // ================================================================
    async _alvcClearSelection() {
        const bounds =
            this.alvcSelection.getBounds();
        if (!bounds) {
            return;
        }
        const columns =
            this._alvcGetRealColumns();
        const records =
            this._alvcGetRecords();
        for (
            let rowIndex = bounds.rowMin;
            rowIndex <= bounds.rowMax;
            rowIndex++
        ) {
            const record = records[rowIndex];

            if (!record) {
                continue;
            }
            const updates = {};
            for (
                let colIndex = bounds.colMin;
                colIndex <= bounds.colMax;
                colIndex++
            ) {
                const column =
                    columns[colIndex];
                if (!column) {
                    continue;
                }
                const fieldDef =
                    record.fields?.[column.name];
                updates[column.name] =
                    this._alvcEmptyValueFor(
                        fieldDef
                    );
            }
            try {
                await record.update(updates);
                if (record.save) {
                    await record.save({
                        reload: false,
                    });
                }
            } catch (error) {
                console.error(
                    "Advanced List View Customizer: failed to clear cells",
                    error
                );
            }
        }
    },

    // ================================================================
    // SELECTION HIGHLIGHT
    // ================================================================
    _alvcRenderSelectionHighlight(table) {
        if (!table) {
            return;
        }
        table
            .querySelectorAll(
                ".o_alvc_selected_cell"
            )
            .forEach((element) => {
                element.classList.remove(
                    "o_alvc_selected_cell"
                );
            });
        table
            .querySelectorAll(
                ".o_alvc_fill_handle"
            )
            .forEach((element) => {
                element.remove();
            });
        const bounds =
            this.alvcSelection.getBounds();
        if (!bounds) {
            return;
        }
        const tbody =
            table.querySelector("tbody");
        if (!tbody) {
            return;
        }
        const rows = Array.from(
            tbody.querySelectorAll(
                ":scope > tr.o_data_row"
            )
        );
        let lastCell = null;
        for (
            let rowIndex = bounds.rowMin;
            rowIndex <= bounds.rowMax;
            rowIndex++
        ) {
            const tr = rows[rowIndex];
            if (!tr) {
                continue;
            }
            const cells = Array.from(
                tr.querySelectorAll(
                    ":scope > td"
                )
            ).filter(
                (cell) =>
                    !cell.classList.contains(
                        "o_list_record_selector"
                    ) &&
                    !cell.classList.contains(
                        "o_handle_cell"
                    ) &&
                    !cell.classList.contains(
                        "o_alvc_calculated_cell"
                    )
            );
            for (
                let colIndex = bounds.colMin;
                colIndex <= bounds.colMax;
                colIndex++
            ) {
                if (cells[colIndex]) {
                    cells[colIndex].classList.add(
                        "o_alvc_selected_cell"
                    );

                    lastCell = cells[colIndex];
                }
            }
        }
        if (!lastCell) {
            return;
        }
        if (
            getComputedStyle(lastCell).position ===
            "static"
        ) {
            lastCell.style.position =
                "relative";
        }
        const handle =
            document.createElement("div");
        handle.className =
            "o_alvc_fill_handle";
        handle.addEventListener(
            "mousedown",
            (event) =>
                this._alvcStartFillDrag(event)
        );
        lastCell.appendChild(handle);
    },

    // ================================================================
    // FILL HANDLE
    // ================================================================
    _alvcStartFillDrag(event) {
        event.preventDefault();
        event.stopPropagation();
        const table =
            this._alvcGetTableEl();
        if (!table) {
            return;
        }
        const onMove = (moveEvent) => {
            const cell =
                this._alvcResolveCell({
                    target: moveEvent.target,
                });
            if (!cell) {
                return;
            }
            table
                .querySelectorAll(
                    ".o_alvc_fill_preview"
                )
                .forEach((element) => {
                    element.classList.remove(
                        "o_alvc_fill_preview"
                    );
                });
            const bounds =
                this.alvcSelection.getBounds();
            if (!bounds) {
                return;
            }
            const tbody =
                table.querySelector("tbody");
            if (!tbody) {
                return;
            }
            const rows = Array.from(
                tbody.querySelectorAll(
                    ":scope > tr.o_data_row"
                )
            );
            const targetRowMax = Math.max(
                bounds.rowMax,
                cell.rowIndex
            );
            for (
                let rowIndex = bounds.rowMax + 1;
                rowIndex <= targetRowMax;
                rowIndex++
            ) {
                const tr = rows[rowIndex];
                if (!tr) {
                    continue;
                }
                const cells = Array.from(
                    tr.querySelectorAll(
                        ":scope > td"
                    )
                ).filter(
                    (element) =>
                        !element.classList.contains(
                            "o_list_record_selector"
                        ) &&
                        !element.classList.contains(
                            "o_handle_cell"
                        ) &&
                        !element.classList.contains(
                            "o_alvc_calculated_cell"
                        )
                );
                for (
                    let colIndex = bounds.colMin;
                    colIndex <= bounds.colMax;
                    colIndex++
                ) {
                    if (cells[colIndex]) {
                        cells[
                            colIndex
                        ].classList.add(
                            "o_alvc_fill_preview"
                        );
                    }
                }
            }
            this._alvcPendingFillRowMax =
                targetRowMax;
        };
        const onUp = async () => {
            window.removeEventListener(
                "mousemove",
                onMove
            );
            window.removeEventListener(
                "mouseup",
                onUp
            );
            table
                .querySelectorAll(
                    ".o_alvc_fill_preview"
                )
                .forEach((element) => {
                    element.classList.remove(
                        "o_alvc_fill_preview"
                    );
                });
            const bounds =
                this.alvcSelection.getBounds();
            if (
                bounds &&
                this._alvcPendingFillRowMax !== null &&
                this._alvcPendingFillRowMax >
                    bounds.rowMax
            ) {
                await this._alvcApplyFillDown(
                    bounds,
                    this._alvcPendingFillRowMax
                );
                this.alvcSelection.extendTo(
                    this._alvcPendingFillRowMax,
                    bounds.colMax
                );
                this._alvcRenderSelectionHighlight(
                    table
                );
            }
            this._alvcPendingFillRowMax = null;
        };
        window.addEventListener(
            "mousemove",
            onMove
        );
        window.addEventListener(
            "mouseup",
            onUp
        );
    },

    async _alvcApplyFillDown(
        bounds,
        targetRowMax
    ) {
        const columns =
            this._alvcGetRealColumns();
        const records =
            this._alvcGetRecords();
        const sourceRowCount =
            bounds.rowMax -
            bounds.rowMin +
            1;
        if (sourceRowCount <= 0) {
            return;
        }
        for (
            let rowIndex = bounds.rowMax + 1;
            rowIndex <= targetRowMax;
            rowIndex++
        ) {
            const targetRecord =
                records[rowIndex];
            if (!targetRecord) {
                continue;
            }
            const sourceIndex =
                bounds.rowMin +
                (
                    (rowIndex - bounds.rowMin) %
                    sourceRowCount
                );
            const sourceRecord =
                records[sourceIndex];
            if (!sourceRecord) {
                continue;
            }
            const updates = {};
            for (
                let colIndex = bounds.colMin;
                colIndex <= bounds.colMax;
                colIndex++
            ) {
                const column =
                    columns[colIndex];
                if (!column) {
                    continue;
                }
                updates[column.name] =
                    sourceRecord.data[
                        column.name
                    ];
            }
            try {
                await targetRecord.update(
                    updates
                );
                if (targetRecord.save) {
                    await targetRecord.save({
                        reload: false,
                    });
                }
            } catch (error) {
                console.error(
                    "Advanced List View Customizer: fill-down failed",
                    error
                );
            }
        }
    },

    // ================================================================
    // FREEZE COLUMNS
    // ================================================================
    _alvcApplyFrozenColumns(table) {
        table
            .querySelectorAll(
                ".o_alvc_frozen_col"
            )
            .forEach((element) => {
                element.classList.remove(
                    "o_alvc_frozen_col",
                    "o_alvc_frozen_col_last"
                );

                element.style.position = "";
                element.style.left = "";
                element.style.zIndex = "";
            });
        const count =
            this.alvcState.frozenColumnCount;
        if (!count) {
            return;
        }
        const headRow =
            table.querySelector(
                "thead tr"
            );
        if (!headRow) {
            return;
        }
        const headCells = Array.from(
            headRow.querySelectorAll(
                ":scope > th"
            )
        ).filter(
            (cell) =>
                !cell.classList.contains(
                    "o_list_record_selector"
                ) &&
                !cell.classList.contains(
                    "o_handle_cell"
                )
        );
        let offset = 0;
        const offsets = [];
        for (
            let index = 0;
            index < Math.min(
                count,
                headCells.length
            );
            index++
        ) {
            offsets.push(offset);

            offset +=
                headCells[
                    index
                ].getBoundingClientRect().width ||
                headCells[index].offsetWidth ||
                120;
        }
        const rows = table.querySelectorAll(
            "thead > tr, tbody > tr.o_data_row"
        );
        rows.forEach((row) => {
            const cells = Array.from(
                row.querySelectorAll(
                    ":scope > th, :scope > td"
                )
            ).filter(
                (cell) =>
                    !cell.classList.contains(
                        "o_list_record_selector"
                    ) &&
                    !cell.classList.contains(
                        "o_handle_cell"
                    ) &&
                    !cell.classList.contains(
                        "o_alvc_calculated_cell"
                    )
            );
            for (
                let index = 0;
                index <
                Math.min(
                    count,
                    cells.length
                );
                index++
            ) {
                const cell = cells[index];

                cell.classList.add(
                    "o_alvc_frozen_col"
                );
                if (
                    index === count - 1
                ) {
                    cell.classList.add(
                        "o_alvc_frozen_col_last"
                    );
                }
                cell.style.position =
                    "sticky";
                cell.style.left =
                    `${offsets[index]}px`;

                cell.style.zIndex =
                    row.closest("thead")
                        ? "4"
                        : "2";
            }
        });
    },

    // ================================================================
    // CALCULATED COLUMNS
    // ================================================================
    _alvcRenderCalculatedColumns(table) {
        table
            .querySelectorAll(
                ".o_alvc_calculated_header, .o_alvc_calculated_cell"
            )
            .forEach((element) => {
                element.remove();
            });

        const calculatedColumns =
            this.alvcState.calculatedColumns;
        if (!calculatedColumns.length) {
            return;
        }
        const headRow =
            table.querySelector(
                "thead tr"
            );
        if (headRow) {
            for (
                const column of calculatedColumns
            ) {
                const th =
                    document.createElement(
                        "th"
                    );

                th.className =
                    "o_alvc_calculated_header";

                th.title =
                    `Calculated column (formula: ${column.formula})`;

                th.textContent =
                    `ƒ ${column.label}`;

                headRow.appendChild(th);
            }
        }
        const tbody =
            table.querySelector("tbody");
        if (!tbody) {
            return;
        }
        const dataRows = Array.from(
            tbody.querySelectorAll(
                ":scope > tr.o_data_row"
            )
        );
        const records =
            this._alvcGetRecords();
        dataRows.forEach(
            (tr, rowIndex) => {
                const record =
                    records[rowIndex];
                for (
                    const column of calculatedColumns
                ) {
                    const td =
                        document.createElement(
                            "td"
                        );
                    td.className =
                        "o_alvc_calculated_cell";
                    let displayValue = "";
                    try {
                        if (record) {
                            if (
                                !column._compiled
                            ) {
                                column._compiled =
                                    compileFormula(
                                        column.formula
                                    );
                            }
                            const raw =
                                column._compiled(
                                    record.data
                                );
                            displayValue =
                                this._alvcFormatCalculatedValue(
                                    raw,
                                    column
                                );
                        }
                    } catch (error) {
                        console.error(
                            "Advanced List View Customizer: formula error",
                            error
                        );
                        displayValue =
                            "#ERR";
                    }
                    td.textContent =
                        displayValue;
                    tr.appendChild(td);
                }
            }
        );
    },

    _alvcFormatCalculatedValue(
        raw,
        column
    ) {
        if (typeof raw === "boolean") {
            return raw
                ? "True"
                : "False";
        }
        if (
            raw === null ||
            raw === undefined
        ) {
            return "";
        }
        const number =
            Number(raw);
        if (!Number.isFinite(number)) {
            return String(raw);
        }
        const formatter =
            NUMBER_FORMATTERS[
                column.column_type
            ] ||
            NUMBER_FORMATTERS.float;
        return formatter(
            number,
            column.decimal_precision
        );
    },

    // ================================================================
    // FREEZE DIALOG
    // ================================================================
    onAlvcOpenFreezeDialog() {
        const maxColumns =
            this._alvcGetRealColumns()
                .length;
        this.dialog.add(
            FreezeColumnsDialog,
            {
                maxColumns,
                currentFrozenCount:
                    this.alvcState
                        .frozenColumnCount,
                onConfirm: (count) => {
                    this.alvcState
                        .frozenColumnCount =
                        Math.max(
                            0,
                            Number(count) || 0
                        );
                },
            }
        );
    },

    // ================================================================
    // CALCULATED COLUMN DIALOG
    // ================================================================
    onAlvcOpenCalculatedColumnDialog() {
        const fieldNames =
            this._alvcGetRealColumns()
                .map(
                    (column) =>
                        column.name
                );
        this.dialog.add(
            CalculatedColumnDialog,
            {
                fieldNames,
                onConfirm: (column) => {
                    this.alvcState
                        .calculatedColumns
                        .push({
                            ...column,
                            _compiled: null,
                        });
                },
            }
        );
    },

    onAlvcRemoveCalculatedColumn(name) {
        this.alvcState
            .calculatedColumns =
            this.alvcState.calculatedColumns
                .filter(
                    (column) =>
                        column.name !== name
                );
    },

    // ================================================================
    // SAVE LAYOUT
    // ================================================================
    onAlvcOpenSaveDialog() {
        this.dialog.add(
            SaveViewDialog,
            {
                defaultName:
                    this.alvcState
                        .activeLayoutName ||
                    "",
                onConfirm:
                    async ({
                        name,
                        isDefault,
                        shared,
                    }) => {
                        await this._alvcPersistLayout({
                            name,
                            isDefault,
                            shared,
                        });
                    },
            }
        );
    },

    async _alvcPersistLayout({
        name,
        isDefault,
        shared,
    }) {
        const resModel =
            this.props.list?.resModel;
        if (!resModel) {
            return;
        }
        const columnConfig =
            JSON.stringify({
                frozenColumnCount:
                    this.alvcState
                        .frozenColumnCount,
            });
        const calculatedColumns =
            this.alvcState
                .calculatedColumns
                .map(
                    ({
                        _compiled,
                        ...column
                    }) => column
                );
        try {
            const result =
                await this.orm.call(
                    "list.view.custom.config",
                    "save_view_config",
                    [
                        {
                            id:
                                this.alvcState
                                    .activeLayoutId ||
                                undefined,

                            name,

                            model_name:
                                resModel,

                            column_config:
                                columnConfig,

                            is_default:
                                isDefault,

                            shared,

                            calculated_columns:
                                calculatedColumns,
                        },
                    ]
                );
            this.alvcState
                .activeLayoutId =
                result.id;
            this.alvcState
                .activeLayoutName =
                result.name;
            this.notification.add(
                "Layout saved.",
                {
                    type: "success",
                }
            );
        } catch (error) {
            console.error(
                "Advanced List View Customizer: failed to save layout",
                error
            );
            this.notification.add(
                "Could not save the layout.",
                {
                    type: "danger",
                }
            );
        }
    },

    // ================================================================
    // LOAD LAYOUT
    // ================================================================
    async onAlvcOpenLoadDialog() {
        const resModel =
            this.props.list?.resModel;
        if (!resModel) {
            return;
        }
        let layouts = [];
        try {
            layouts =
                await this.orm.call(
                    "list.view.custom.config",
                    "get_views_for_model",
                    [resModel]
                );
        } catch (error) {
            console.error(
                "Advanced List View Customizer: failed to fetch layouts",
                error
            );
        }
        this.dialog.add(
            LoadViewDialog,
            {
                layouts,
                onLoad: (layout) => {
                    this._alvcApplyLayout(
                        layout
                    );
                },
                onDelete:
                    async (layout) => {
                        try {
                            await this.orm.call(
                                "list.view.custom.config",
                                "delete_view_config",
                                [layout.id]
                            );
                        } catch (error) {
                            console.error(
                                "Advanced List View Customizer: failed to delete layout",
                                error
                            );
                        }
                    },
            }
        );
    },

    _alvcApplyLayout(layout) {
        try {
            const columnConfig =
                layout.column_config
                    ? JSON.parse(
                        layout.column_config
                    )
                    : {};
            this.alvcState
                .frozenColumnCount =
                Number(
                    columnConfig
                        .frozenColumnCount
                ) || 0;
        } catch {
            this.alvcState
                .frozenColumnCount = 0;
        }
        this.alvcState
            .calculatedColumns =
            (
                layout.calculated_columns ||
                []
            ).map(
                (column) => ({
                    ...column,
                    _compiled: null,
                })
            );
        this.alvcState
            .activeLayoutId =
            layout.id;
        this.alvcState
            .activeLayoutName =
            layout.name;
    },

    // ================================================================
    // DEFAULT LAYOUT
    // ================================================================
    async _alvcLoadDefaultLayout() {
        const resModel =
            this.props.list?.resModel;
        if (!resModel) {
            return;
        }
        try {
            const layout =
                await this.orm.call(
                    "list.view.custom.config",
                    "get_default_view_for_model",
                    [resModel]
                );
            if (layout) {
                this._alvcApplyLayout(
                    layout
                );
            }
        } catch (error) {
            console.warn(
                "Advanced List View Customizer: could not load default layout",
                error
            );
        }
    },
});

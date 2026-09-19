/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import {
    onMounted,
    onPatched,
    useExternalListener,
    useState,
} from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { ListRenderer } from "@web/views/list/list_renderer";

import { CellSelectionManager } from "./utils/cell_selection_manager";
import { gridToTsv, tsvToGrid, writeClipboardText } from "./utils/clipboard_utils";
import { compileFormula } from "./utils/safe_formula_evaluator";
import { getDataRows, getFieldCells, insertBeforeTrailingControls } from "./utils/table_dom";

import { SaveViewDialog } from "./components/save_view_dialog";
import { LoadViewDialog } from "./components/load_view_dialog";
import { CalculatedColumnDialog } from "./components/calculated_column_dialog";
import { FreezeColumnsDialog } from "./components/freeze_columns_dialog";

const NUMBER_FORMATTERS = {
    integer: (value) => Math.round(Number(value)).toLocaleString(),
    float: (value, precision) => Number(value).toFixed(precision ?? 2),
    monetary: (value, precision) => Number(value).toFixed(precision ?? 2),
    percentage: (value, precision) => (Number(value) * 100).toFixed(precision ?? 2) + "%",
};

function wrapIndex(value, min, count) {
    const offset = ((value - min) % count + count) % count;
    return min + offset;
}

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
        this._alvcPendingFill = null;
        this._alvcPendingColumnConfig = null;

        useExternalListener(window, "mouseup", this._alvcOnMouseUp.bind(this));
        useExternalListener(window, "keydown", this._alvcOnKeyDown.bind(this));

        onMounted(async () => {
            await this._alvcLoadDefaultLayout();
            this._alvcSetupTable();
        });
        onPatched(() => this._alvcSetupTable());
    },

    _alvcGetTableEl() {
        return this.tableRef?.el || this.rootRef?.el?.querySelector("table.o_list_table") || null;
    },

    _alvcGetRecords() {
        return this.props.list?.records || [];
    },

    _alvcGetRealColumns() {
        const columns = this.columns || [];
        return columns.filter((column) => column.type === "field" && column.widget !== "handle");
    },

    _alvcSetupTable() {
        const table = this._alvcGetTableEl();
        if (!table) {
            return;
        }
        this._alvcBindSelectionEvents(table);
        this._alvcApplyPendingColumnConfig(table);
        this._alvcApplyFrozenColumns(table);
        this._alvcRenderCalculatedColumns(table);
        this._alvcRenderSelectionHighlight(table);
    },

    _alvcBindSelectionEvents(table) {
        if (table.dataset.alvcBound === "1") {
            return;
        }
        table.dataset.alvcBound = "1";
        table.addEventListener("mousedown", (event) => this._alvcOnCellMouseDown(event));
        table.addEventListener("mouseover", (event) => this._alvcOnCellMouseOver(event));
    },

    _alvcResolveCell(event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return null;
        }
        const td = target.closest("td");
        if (!td) {
            return null;
        }
        const tr = td.closest("tr.o_data_row");
        const table = this._alvcGetTableEl();
        if (!tr || !table || !table.contains(tr)) {
            return null;
        }
        if (td.classList.contains("o_alvc_calculated_cell")) {
            return null;
        }
        const dataRows = getDataRows(table);
        const rowIndex = dataRows.indexOf(tr);
        if (rowIndex === -1) {
            return null;
        }
        const cells = getFieldCells(tr);
        const colIndex = cells.indexOf(td);
        if (colIndex === -1) {
            return null;
        }
        return { rowIndex, colIndex, td, tr };
    },

    _alvcOnCellMouseDown(event) {
        if (event.button !== 0 || event.target.closest(".o_alvc_fill_handle")) {
            return;
        }
        const cell = this._alvcResolveCell(event);
        if (!cell) {
            return;
        }
        if (event.shiftKey && this.alvcSelection.hasSelection()) {
            this.alvcSelection.extendTo(cell.rowIndex, cell.colIndex);
        } else {
            this.alvcSelection.start(cell.rowIndex, cell.colIndex);
        }
        this._alvcRenderSelectionHighlight(this._alvcGetTableEl());
    },

    _alvcOnCellMouseOver(event) {
        if (!this.alvcSelection.isSelecting) {
            return;
        }
        const cell = this._alvcResolveCell(event);
        if (!cell) {
            return;
        }
        this.alvcSelection.extendTo(cell.rowIndex, cell.colIndex);
        this._alvcRenderSelectionHighlight(this._alvcGetTableEl());
    },

    _alvcOnMouseUp() {
        if (this.alvcSelection.isSelecting) {
            this.alvcSelection.stop();
        }
    },

    _alvcIsEditingText() {
        const el = document.activeElement;
        if (!el) {
            return false;
        }
        const tag = el.tagName;
        if (el.isContentEditable || tag === "TEXTAREA") {
            return true;
        }
        if (tag === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(el.type)) {
            return true;
        }
        return Boolean(el.closest(".o_selected_row, .o_dialog, .modal"));
    },

    _alvcIsKeyboardTarget() {
        const table = this._alvcGetTableEl();
        if (!table || !this.alvcSelection.hasSelection()) {
            return false;
        }
        const active = document.activeElement;
        const root = this.rootRef?.el;
        if (active && root?.contains(active)) {
            return true;
        }
        if (active?.closest?.(".o_list_renderer") && root && !root.contains(active)) {
            return false;
        }
        return true;
    },

    _alvcOnKeyDown(event) {
        if (!this._alvcIsKeyboardTarget() || this._alvcIsEditingText()) {
            return;
        }
        const key = event.key.toLowerCase();
        const isCopy = (event.ctrlKey || event.metaKey) && key === "c";
        const isPaste = (event.ctrlKey || event.metaKey) && key === "v";
        const isSelectAll = (event.ctrlKey || event.metaKey) && key === "a";
        const isDelete = event.key === "Delete" || event.key === "Backspace";
        const isEscape = event.key === "Escape";

        if (isCopy) {
            event.preventDefault();
            this._alvcCopySelection();
        } else if (isPaste) {
            event.preventDefault();
            this._alvcPasteIntoSelection();
        } else if (isDelete) {
            event.preventDefault();
            this._alvcClearSelection();
        } else if (isSelectAll) {
            event.preventDefault();
            const records = this._alvcGetRecords();
            const columns = this._alvcGetRealColumns();
            if (records.length && columns.length) {
                this.alvcSelection.start(0, 0);
                this.alvcSelection.extendTo(records.length - 1, columns.length - 1);
                this.alvcSelection.stop();
                this._alvcRenderSelectionHighlight(this._alvcGetTableEl());
            }
        } else if (isEscape) {
            this.alvcSelection.clear();
            this._alvcRenderSelectionHighlight(this._alvcGetTableEl());
        }
    },

    async _alvcCopySelection() {
        const table = this._alvcGetTableEl();
        const bounds = this.alvcSelection.getBounds();
        if (!table || !bounds) {
            return;
        }
        const rows = getDataRows(table);
        const grid = [];
        for (let rowIndex = bounds.rowMin; rowIndex <= bounds.rowMax; rowIndex++) {
            const cells = getFieldCells(rows[rowIndex]);
            const row = [];
            for (let colIndex = bounds.colMin; colIndex <= bounds.colMax; colIndex++) {
                row.push(cells[colIndex] ? cells[colIndex].innerText.trim() : "");
            }
            grid.push(row);
        }
        await writeClipboardText(gridToTsv(grid));
    },

    async _alvcPasteIntoSelection() {
        if (!navigator.clipboard?.readText) {
            this.notification.add(_t("Clipboard access isn't available in this browser context."), {
                type: "warning",
            });
            return;
        }
        let text;
        try {
            text = await navigator.clipboard.readText();
        } catch {
            this.notification.add(_t("Could not read from the clipboard. Please allow clipboard access."), {
                type: "warning",
            });
            return;
        }
        const grid = tsvToGrid(text);
        if (!grid.length) {
            return;
        }
        const anchor = this.alvcSelection.getAnchorCell() || { rowIndex: 0, colIndex: 0 };
        const columns = this._alvcGetRealColumns();
        const records = this._alvcGetRecords();
        let unsupportedFieldWarned = false;
        for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
            const record = records[anchor.rowIndex + rowIndex];
            if (!record) {
                break;
            }
            const rowValues = grid[rowIndex];
            const updates = {};
            for (let colIndex = 0; colIndex < rowValues.length; colIndex++) {
                const column = columns[anchor.colIndex + colIndex];
                if (!column) {
                    continue;
                }
                const value = this._alvcCoerceValue(rowValues[colIndex], record.fields?.[column.name]);
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
                console.error("Advanced List View Customizer: failed to update record", error);
            }
        }
        await this._alvcSaveDirtyRecords(records);
        if (unsupportedFieldWarned) {
            this.notification.add(
                _t("Some columns such as relational or selection fields were skipped."),
                { type: "warning" }
            );
        }
    },

    async _alvcSaveDirtyRecords(records) {
        try {
            const root = this.props.list?.model?.root;
            if (root?.save) {
                await root.save({ reload: false });
                return;
            }
            for (const record of records) {
                if (record.dirty && record.save) {
                    await record.save({ reload: false });
                }
            }
        } catch (error) {
            console.error("Advanced List View Customizer: failed to save values", error);
            this.notification.add(_t("Some values could not be saved."), { type: "danger" });
        }
    },

    _alvcCoerceValue(text, fieldDef) {
        const type = fieldDef?.type;
        const trimmed = String(text ?? "").trim();
        switch (type) {
            case "integer":
                return trimmed === "" ? false : parseInt(trimmed, 10) || 0;
            case "float":
            case "monetary":
                return trimmed === "" ? false : parseFloat(trimmed.replace(",", ".")) || 0;
            case "boolean":
                return ["1", "true", "yes", "y"].includes(trimmed.toLowerCase());
            case "char":
            case "text":
            case "html":
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
        if (["integer", "float", "monetary"].includes(type)) {
            return 0;
        }
        if (type === "boolean") {
            return false;
        }
        if (["many2many", "one2many"].includes(type)) {
            return [[5, 0, 0]];
        }
        return false;
    },

    _alvcCloneFieldValue(record, fieldName) {
        const fieldDef = record.fields?.[fieldName];
        const value = record.data?.[fieldName];
        if (!fieldDef) {
            return undefined;
        }
        if (["many2many", "one2many"].includes(fieldDef.type)) {
            return undefined;
        }
        if (fieldDef.type === "many2one") {
            if (!value) {
                return false;
            }
            return typeof value === "object" ? value.id || false : value;
        }
        return value;
    },

    async _alvcClearSelection() {
        const bounds = this.alvcSelection.getBounds();
        if (!bounds) {
            return;
        }
        const columns = this._alvcGetRealColumns();
        const records = this._alvcGetRecords();
        for (let rowIndex = bounds.rowMin; rowIndex <= bounds.rowMax; rowIndex++) {
            const record = records[rowIndex];
            if (!record) {
                continue;
            }
            const updates = {};
            for (let colIndex = bounds.colMin; colIndex <= bounds.colMax; colIndex++) {
                const column = columns[colIndex];
                if (!column) {
                    continue;
                }
                updates[column.name] = this._alvcEmptyValueFor(record.fields?.[column.name]);
            }
            try {
                await record.update(updates);
            } catch (error) {
                console.error("Advanced List View Customizer: failed to clear cells", error);
            }
        }
        await this._alvcSaveDirtyRecords(records);
    },

    _alvcRenderSelectionHighlight(table) {
        if (!table) {
            return;
        }
        table.querySelectorAll(".o_alvc_selected_cell").forEach((el) => {
            el.classList.remove("o_alvc_selected_cell");
        });
        table.querySelectorAll(".o_alvc_fill_handle").forEach((el) => el.remove());
        const bounds = this.alvcSelection.getBounds();
        if (!bounds) {
            return;
        }
        const rows = getDataRows(table);
        let lastCell = null;
        for (let rowIndex = bounds.rowMin; rowIndex <= bounds.rowMax; rowIndex++) {
            const cells = getFieldCells(rows[rowIndex]);
            for (let colIndex = bounds.colMin; colIndex <= bounds.colMax; colIndex++) {
                if (cells[colIndex]) {
                    cells[colIndex].classList.add("o_alvc_selected_cell");
                    lastCell = cells[colIndex];
                }
            }
        }
        if (!lastCell) {
            return;
        }
        if (getComputedStyle(lastCell).position === "static") {
            lastCell.style.position = "relative";
        }
        const handle = document.createElement("div");
        handle.className = "o_alvc_fill_handle";
        handle.addEventListener("mousedown", (event) => this._alvcStartFillDrag(event));
        lastCell.appendChild(handle);
    },

    _alvcStartFillDrag(event) {
        event.preventDefault();
        event.stopPropagation();
        const table = this._alvcGetTableEl();
        if (!table) {
            return;
        }
        const onMove = (moveEvent) => {
            const cell = this._alvcResolveCell({ target: moveEvent.target });
            const bounds = this.alvcSelection.getBounds();
            table.querySelectorAll(".o_alvc_fill_preview").forEach((el) => {
                el.classList.remove("o_alvc_fill_preview");
            });
            if (!cell || !bounds) {
                return;
            }
            const fillBounds = {
                rowMin: Math.min(bounds.rowMin, cell.rowIndex),
                rowMax: Math.max(bounds.rowMax, cell.rowIndex),
                colMin: Math.min(bounds.colMin, cell.colIndex),
                colMax: Math.max(bounds.colMax, cell.colIndex),
            };
            this._alvcPaintFillPreview(table, bounds, fillBounds);
            this._alvcPendingFill = fillBounds;
        };
        const onUp = async () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            table.querySelectorAll(".o_alvc_fill_preview").forEach((el) => {
                el.classList.remove("o_alvc_fill_preview");
            });
            const bounds = this.alvcSelection.getBounds();
            const fillBounds = this._alvcPendingFill;
            if (bounds && fillBounds) {
                await this._alvcApplyFill(bounds, fillBounds);
                this.alvcSelection.start(fillBounds.rowMin, fillBounds.colMin);
                this.alvcSelection.extendTo(fillBounds.rowMax, fillBounds.colMax);
                this.alvcSelection.stop();
                this._alvcRenderSelectionHighlight(table);
            }
            this._alvcPendingFill = null;
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    },

    _alvcPaintFillPreview(table, source, fillBounds) {
        const rows = getDataRows(table);
        for (let rowIndex = fillBounds.rowMin; rowIndex <= fillBounds.rowMax; rowIndex++) {
            const cells = getFieldCells(rows[rowIndex]);
            for (let colIndex = fillBounds.colMin; colIndex <= fillBounds.colMax; colIndex++) {
                const inSource =
                    rowIndex >= source.rowMin &&
                    rowIndex <= source.rowMax &&
                    colIndex >= source.colMin &&
                    colIndex <= source.colMax;
                if (!inSource && cells[colIndex]) {
                    cells[colIndex].classList.add("o_alvc_fill_preview");
                }
            }
        }
    },

    async _alvcApplyFill(source, fillBounds) {
        const columns = this._alvcGetRealColumns();
        const records = this._alvcGetRecords();
        const sourceRowCount = source.rowMax - source.rowMin + 1;
        const sourceColCount = source.colMax - source.colMin + 1;
        if (sourceRowCount <= 0 || sourceColCount <= 0) {
            return;
        }
        for (let rowIndex = fillBounds.rowMin; rowIndex <= fillBounds.rowMax; rowIndex++) {
            const targetRecord = records[rowIndex];
            if (!targetRecord) {
                continue;
            }
            const updates = {};
            for (let colIndex = fillBounds.colMin; colIndex <= fillBounds.colMax; colIndex++) {
                const inSource =
                    rowIndex >= source.rowMin &&
                    rowIndex <= source.rowMax &&
                    colIndex >= source.colMin &&
                    colIndex <= source.colMax;
                if (inSource) {
                    continue;
                }
                const column = columns[colIndex];
                if (!column) {
                    continue;
                }
                const sourceRecord = records[wrapIndex(rowIndex, source.rowMin, sourceRowCount)];
                const sourceColumn = columns[wrapIndex(colIndex, source.colMin, sourceColCount)];
                if (!sourceRecord || !sourceColumn) {
                    continue;
                }
                const value = this._alvcCloneFieldValue(sourceRecord, sourceColumn.name);
                if (value === undefined) {
                    continue;
                }
                updates[column.name] = value;
            }
            if (!Object.keys(updates).length) {
                continue;
            }
            try {
                await targetRecord.update(updates);
            } catch (error) {
                console.error("Advanced List View Customizer: fill failed", error);
            }
        }
        await this._alvcSaveDirtyRecords(records);
    },

    _alvcApplyFrozenColumns(table) {
        table.querySelectorAll(".o_alvc_frozen_col").forEach((element) => {
            element.classList.remove("o_alvc_frozen_col", "o_alvc_frozen_col_last");
            element.style.position = "";
            element.style.left = "";
            element.style.zIndex = "";
        });
        const count = this.alvcState.frozenColumnCount;
        if (!count) {
            return;
        }
        const headRow = table.querySelector("thead tr");
        if (!headRow) {
            return;
        }
        const headCells = getFieldCells(headRow);
        const offsets = [];
        let offset = 0;
        for (let index = 0; index < Math.min(count, headCells.length); index++) {
            offsets.push(offset);
            offset += headCells[index].getBoundingClientRect().width || headCells[index].offsetWidth || 120;
        }
        table.querySelectorAll("thead > tr, tbody > tr.o_data_row").forEach((row) => {
            const cells = getFieldCells(row);
            for (let index = 0; index < Math.min(count, cells.length); index++) {
                const cell = cells[index];
                cell.classList.add("o_alvc_frozen_col");
                if (index === count - 1) {
                    cell.classList.add("o_alvc_frozen_col_last");
                }
                cell.style.position = "sticky";
                cell.style.left = `${offsets[index]}px`;
                cell.style.zIndex = row.closest("thead") ? "4" : "2";
            }
        });
    },

    _alvcRenderCalculatedColumns(table) {
        table.querySelectorAll(".o_alvc_calculated_header, .o_alvc_calculated_cell").forEach((el) => el.remove());
        const calculatedColumns = this.alvcState.calculatedColumns;
        if (!calculatedColumns.length) {
            return;
        }
        const headRow = table.querySelector("thead tr");
        if (headRow) {
            for (const column of calculatedColumns) {
                const th = document.createElement("th");
                th.className = "o_alvc_calculated_header";
                th.title = _t("Calculated column (formula: %s)", column.formula);
                th.textContent = `ƒ ${column.label}`;
                insertBeforeTrailingControls(headRow, th);
            }
        }
        const records = this._alvcGetRecords();
        getDataRows(table).forEach((tr, rowIndex) => {
            const record = records[rowIndex];
            for (const column of calculatedColumns) {
                const td = document.createElement("td");
                td.className = "o_alvc_calculated_cell";
                let displayValue = "";
                try {
                    if (record) {
                        if (!column._compiled) {
                            column._compiled = compileFormula(column.formula);
                        }
                        displayValue = this._alvcFormatCalculatedValue(
                            column._compiled(record.data),
                            column
                        );
                    }
                } catch (error) {
                    console.error("Advanced List View Customizer: formula error", error);
                    displayValue = "#ERR";
                }
                td.textContent = displayValue;
                insertBeforeTrailingControls(tr, td);
            }
        });
    },

    _alvcFormatCalculatedValue(raw, column) {
        if (typeof raw === "boolean") {
            return raw ? "True" : "False";
        }
        if (raw === null || raw === undefined) {
            return "";
        }
        const number = Number(raw);
        if (!Number.isFinite(number)) {
            return String(raw);
        }
        const formatter = NUMBER_FORMATTERS[column.column_type] || NUMBER_FORMATTERS.float;
        return formatter(number, column.decimal_precision);
    },

    _alvcCollectColumnConfig(table) {
        const widths = {};
        if (table) {
            getFieldCells(table.querySelector("thead tr")).forEach((th) => {
                const name = th.dataset.name;
                if (name) {
                    widths[name] = Math.round(th.getBoundingClientRect().width || th.offsetWidth);
                }
            });
        }
        const optionalFields = {};
        for (const [name, active] of Object.entries(this.optionalActiveFields || {})) {
            optionalFields[name] = Boolean(active);
        }
        return {
            frozenColumnCount: this.alvcState.frozenColumnCount,
            columnNames: this._alvcGetRealColumns().map((column) => column.name),
            columnWidths: widths,
            optionalFields,
        };
    },

    _alvcApplyPendingColumnConfig(table) {
        const config = this._alvcPendingColumnConfig;
        if (!config || !table) {
            return;
        }
        if (config.columnWidths) {
            getFieldCells(table.querySelector("thead tr")).forEach((th) => {
                const width = config.columnWidths[th.dataset.name];
                if (width) {
                    th.style.width = `${width}px`;
                    th.style.minWidth = `${width}px`;
                }
            });
        }
        this._alvcPendingColumnConfig = null;
    },

    _alvcApplyOptionalFields(optionalFields) {
        if (!optionalFields || !this.optionalActiveFields) {
            return false;
        }
        let changed = false;
        for (const column of this.allColumns || []) {
            if (!column.optional) {
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(optionalFields, column.name)) {
                const next = Boolean(optionalFields[column.name]);
                if (this.optionalActiveFields[column.name] !== next) {
                    this.optionalActiveFields[column.name] = next;
                    changed = true;
                }
            }
        }
        if (changed && this.saveOptionalActiveFields) {
            this.saveOptionalActiveFields();
            this.render();
        }
        return changed;
    },

    onAlvcOpenFreezeDialog() {
        this.dialog.add(FreezeColumnsDialog, {
            maxColumns: this._alvcGetRealColumns().length,
            currentFrozenCount: this.alvcState.frozenColumnCount,
            onConfirm: (count) => {
                this.alvcState.frozenColumnCount = Math.max(0, Number(count) || 0);
            },
        });
    },

    onAlvcOpenCalculatedColumnDialog() {
        this.dialog.add(CalculatedColumnDialog, {
            fieldNames: this._alvcGetRealColumns().map((column) => column.name),
            onConfirm: (column) => {
                const existing = this.alvcState.calculatedColumns.find((item) => item.name === column.name);
                if (existing) {
                    Object.assign(existing, column, { _compiled: null });
                } else {
                    this.alvcState.calculatedColumns.push({ ...column, _compiled: null });
                }
            },
        });
    },

    onAlvcRemoveCalculatedColumn(name) {
        this.alvcState.calculatedColumns = this.alvcState.calculatedColumns.filter(
            (column) => column.name !== name
        );
    },

    onAlvcOpenSaveDialog() {
        this.dialog.add(SaveViewDialog, {
            defaultName: this.alvcState.activeLayoutName || "",
            onConfirm: async ({ name, isDefault, shared }) => {
                await this._alvcPersistLayout({ name, isDefault, shared });
            },
        });
    },

    async _alvcPersistLayout({ name, isDefault, shared }) {
        const resModel = this.props.list?.resModel;
        if (!resModel) {
            return;
        }
        const calculatedColumns = this.alvcState.calculatedColumns.map(({ _compiled, ...column }) => column);
        try {
            const result = await this.orm.call("list.view.custom.config", "save_view_config", [
                {
                    id: this.alvcState.activeLayoutId || undefined,
                    name,
                    model_name: resModel,
                    column_config: JSON.stringify(this._alvcCollectColumnConfig(this._alvcGetTableEl())),
                    is_default: isDefault,
                    shared,
                    calculated_columns: calculatedColumns,
                },
            ]);
            this.alvcState.activeLayoutId = result.id;
            this.alvcState.activeLayoutName = result.name;
            this.notification.add(_t("Layout saved."), { type: "success" });
        } catch (error) {
            console.error("Advanced List View Customizer: failed to save layout", error);
            this.notification.add(_t("Could not save the layout."), { type: "danger" });
        }
    },

    async onAlvcOpenLoadDialog() {
        const resModel = this.props.list?.resModel;
        if (!resModel) {
            return;
        }
        let layouts = [];
        try {
            layouts = await this.orm.call("list.view.custom.config", "get_views_for_model", [resModel]);
        } catch (error) {
            console.error("Advanced List View Customizer: failed to fetch layouts", error);
        }
        this.dialog.add(LoadViewDialog, {
            layouts,
            onLoad: (layout) => this._alvcApplyLayout(layout),
            onDelete: async (layout) => {
                try {
                    await this.orm.call("list.view.custom.config", "delete_view_config", [layout.id]);
                } catch (error) {
                    console.error("Advanced List View Customizer: failed to delete layout", error);
                }
            },
        });
    },

    _alvcApplyLayout(layout) {
        let columnConfig = {};
        try {
            columnConfig = layout.column_config ? JSON.parse(layout.column_config) : {};
        } catch {
            columnConfig = {};
        }
        this.alvcState.frozenColumnCount = Number(columnConfig.frozenColumnCount) || 0;
        this.alvcState.calculatedColumns = (layout.calculated_columns || []).map((column) => ({
            ...column,
            _compiled: null,
        }));
        this.alvcState.activeLayoutId = layout.id;
        this.alvcState.activeLayoutName = layout.name;
        this._alvcPendingColumnConfig = columnConfig;
        this._alvcApplyOptionalFields(columnConfig.optionalFields);
    },

    async _alvcLoadDefaultLayout() {
        const resModel = this.props.list?.resModel;
        if (!resModel) {
            return;
        }
        try {
            const layout = await this.orm.call(
                "list.view.custom.config",
                "get_default_view_for_model",
                [resModel]
            );
            if (layout) {
                this._alvcApplyLayout(layout);
            }
        } catch (error) {
            console.warn("Advanced List View Customizer: could not load default layout", error);
        }
    },
});
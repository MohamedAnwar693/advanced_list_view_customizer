/** @odoo-module **/
const SKIP_CELL_CLASSES = [
    "o_list_record_selector",
    "o_handle_cell",
    "o_list_button",
    "o_list_open_form_view",
    "o_list_record_open_form_view",
    "o_list_controller",
    "o_alvc_calculated_cell",
];

export function isSkippedCell(cell) {
    return SKIP_CELL_CLASSES.some((className) => cell.classList.contains(className));
}

export function getFieldCells(row) {
    if (!row) {
        return [];
    }
    return Array.from(row.querySelectorAll(":scope > th, :scope > td")).filter(
        (cell) => !isSkippedCell(cell)
    );
}

export function getDataRows(table) {
    if (!table) {
        return [];
    }
    return Array.from(table.querySelectorAll("tbody > tr.o_data_row"));
}

export function insertBeforeTrailingControls(parent, node) {
    const trailing = parent.querySelector(
        ":scope > .o_list_open_form_view, :scope > .o_list_record_open_form_view, :scope > .o_list_controller"
    );
    if (trailing) {
        parent.insertBefore(node, trailing);
    } else {
        parent.appendChild(node);
    }
}
/** @odoo-module **/

export function gridToTsv(grid) {
    return grid.map((row) => row.map((cell) => (cell ?? "")).join("\t")).join("\n");
}

export function tsvToGrid(text) {
    const normalized = (text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    // Drop a single trailing empty line that most spreadsheet apps append.
    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines.map((line) => line.split("\t"));
}

/** @odoo-module **/


export class CellSelectionManager {
    constructor() {
        this.anchor = null;
        this.focus = null;
        this.isSelecting = false;
    }

    start(rowIndex, colIndex) {
        this.anchor = { rowIndex, colIndex };
        this.focus = { rowIndex, colIndex };
        this.isSelecting = true;
    }

    extendTo(rowIndex, colIndex) {
        if (!this.anchor) {
            this.start(rowIndex, colIndex);
            return;
        }
        this.focus = { rowIndex, colIndex };
    }

    stop() {
        this.isSelecting = false;
    }

    clear() {
        this.anchor = null;
        this.focus = null;
        this.isSelecting = false;
    }

    hasSelection() {
        return !!(this.anchor && this.focus);
    }
    getBounds() {
        if (!this.hasSelection()) {
            return null;
        }
        return {
            rowMin: Math.min(this.anchor.rowIndex, this.focus.rowIndex),
            rowMax: Math.max(this.anchor.rowIndex, this.focus.rowIndex),
            colMin: Math.min(this.anchor.colIndex, this.focus.colIndex),
            colMax: Math.max(this.anchor.colIndex, this.focus.colIndex),
        };
    }
    isCellSelected(rowIndex, colIndex) {
        const bounds = this.getBounds();
        if (!bounds) {
            return false;
        }
        return (
            rowIndex >= bounds.rowMin && rowIndex <= bounds.rowMax &&
            colIndex >= bounds.colMin && colIndex <= bounds.colMax
        );
    }
    getAnchorCell() {
        return this.anchor;
    }
    getBottomRightCell() {
        const bounds = this.getBounds();
        if (!bounds) {
            return null;
        }
        return { rowIndex: bounds.rowMax, colIndex: bounds.colMax };
    }
}

/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

export class FreezeColumnsDialog extends Component {
    static template = "advanced_list_view_customizer.FreezeColumnsDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        maxColumns: Number,
        currentFrozenCount: { type: Number, optional: true },
        onConfirm: Function,
    };

    setup() {
        this.state = useState({
            frozenCount: this.props.currentFrozenCount || 0,
        });
    }
    onConfirmClick() {
        const count = Math.max(0, Math.min(this.props.maxColumns, Number(this.state.frozenCount) || 0));
        this.props.onConfirm(count);
        this.props.close();
    }
    onCancelClick() {
        this.props.close();
    }
}

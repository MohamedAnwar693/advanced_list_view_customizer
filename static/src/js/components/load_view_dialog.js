/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

export class LoadViewDialog extends Component {
    static template = "advanced_list_view_customizer.LoadViewDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        layouts: Array,
        onLoad: Function,
        onDelete: Function,
    };

    setup() {
        this.state = useState({ layouts: this.props.layouts });
    }
    onLoadClick(layout) {
        this.props.onLoad(layout);
        this.props.close();
    }
    async onDeleteClick(layout) {
        await this.props.onDelete(layout);
        this.state.layouts = this.state.layouts.filter((l) => l.id !== layout.id);
    }
    onCancelClick() {
        this.props.close();
    }
}

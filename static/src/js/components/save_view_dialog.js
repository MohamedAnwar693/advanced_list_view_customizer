/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";


export class SaveViewDialog extends Component {
    static template = "advanced_list_view_customizer.SaveViewDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        defaultName: { type: String, optional: true },
        onConfirm: Function,
    };

    setup() {
        this.state = useState({
            name: this.props.defaultName || "",
            isDefault: false,
            shared: false,
            error: "",
        });
    }
    onConfirmClick() {
        const name = this.state.name.trim();
        if (!name) {
            this.state.error = "Please give this layout a name.";
            return;
        }
        this.props.onConfirm({
            name,
            isDefault: this.state.isDefault,
            shared: this.state.shared,
        });
        this.props.close();
    }
    onCancelClick() {
        this.props.close();
    }
}

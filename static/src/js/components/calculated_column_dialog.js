/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { compileFormula, FormulaSyntaxError } from "../utils/safe_formula_evaluator";

export class CalculatedColumnDialog extends Component {
    static template = "advanced_list_view_customizer.CalculatedColumnDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        fieldNames: { type: Array, optional: true },
        onConfirm: Function,
        edit: { type: Object, optional: true },
    };

    setup() {
        const edit = this.props.edit || {};
        this.state = useState({
            name: edit.name || "",
            label: edit.label || "",
            formula: edit.formula || "",
            columnType: edit.column_type || "float",
            decimalPrecision: edit.decimal_precision ?? 2,
            error: "",
        });
    }

    get fieldHint() {
        return (this.props.fieldNames || []).join(", ");
    }
    onConfirmClick() {
        const name = this.state.name.trim();
        const label = this.state.label.trim();
        const formula = this.state.formula.trim();

        if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            this.state.error = "Technical name must start with a letter/underscore and contain only letters, digits, underscores.";
            return;
        }
        if (!label) {
            this.state.error = "Please provide a column label.";
            return;
        }
        if (!formula) {
            this.state.error = "Please provide a formula.";
            return;
        }
        try {
            compileFormula(formula);
        } catch (e) {
            if (e instanceof FormulaSyntaxError) {
                this.state.error = "Formula error: " + e.message;
                return;
            }
            throw e;
        }

        this.props.onConfirm({
            name,
            label,
            formula,
            column_type: this.state.columnType,
            decimal_precision: Number(this.state.decimalPrecision) || 0,
        });
        this.props.close();
    }
    onCancelClick() {
        this.props.close();
    }
}

import ast
import re

from odoo import api, fields, models
from odoo.exceptions import ValidationError

# Only a narrow whitelist of AST node types is permitted in a formula.
# This mirrors the restrictions enforced again, independently, on the
# JavaScript side before a formula is ever evaluated against loaded records.
_SAFE_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.FloorDiv,
    ast.USub, ast.UAdd, ast.Load, ast.Name,
    ast.Compare, ast.Gt, ast.Lt, ast.GtE, ast.LtE, ast.Eq, ast.NotEq,
    ast.IfExp, ast.BoolOp, ast.And, ast.Or,
)

_NAME_RE = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*$')


class ListCalculatedColumn(models.Model):
    """A user-defined virtual column shown alongside a saved list layout.

    The value is never stored in the database: it is computed on the fly
    (client-side, in JS) for every visible row from the field values that
    are already loaded in the list view. The formula is still validated
    server-side against a strict whitelist so nothing unsafe can ever be
    persisted or shared with other users.
    """

    _name = 'list.calculated.column'
    _description = 'Calculated (Virtual) List Column'
    _order = 'sequence, id'

    name = fields.Char(
        string='Technical Name', required=True,
        help='Internal identifier for this column, e.g. "margin_pct". Letters, digits and '
             'underscores only.',
    )
    label = fields.Char(string='Column Label', required=True, help='Header text shown to users.')
    config_id = fields.Many2one(
        'list.view.custom.config', string='Saved Layout', ondelete='cascade', index=True,
    )
    model_name = fields.Char(string='Model', related='config_id.model_name', store=True, readonly=True)
    formula = fields.Char(
        string='Formula', required=True,
        help='Arithmetic expression using field technical names, e.g. '
             '"(price_unit * product_uom_qty) - discount"',
    )
    column_type = fields.Selection([
        ('float', 'Decimal'),
        ('integer', 'Integer'),
        ('monetary', 'Monetary'),
        ('percentage', 'Percentage'),
    ], default='float', required=True)
    decimal_precision = fields.Integer(default=2)
    sequence = fields.Integer(default=10)

    @api.constrains('name')
    def _check_name_format(self):
        for rec in self:
            if rec.name and not _NAME_RE.match(rec.name):
                raise ValidationError(
                    'Technical Name "%s" is invalid. Use only letters, digits and underscores, '
                    'and do not start with a digit.' % rec.name
                )

    @api.constrains('formula')
    def _check_formula_safety(self):
        for rec in self:
            if not rec.formula:
                continue
            try:
                tree = ast.parse(rec.formula, mode='eval')
            except SyntaxError:
                raise ValidationError('Invalid formula syntax: %s' % rec.formula)
            for node in ast.walk(tree):
                if not isinstance(node, _SAFE_NODES):
                    raise ValidationError(
                        'Formula "%s" contains a disallowed expression (%s). '
                        'Only arithmetic and comparisons on field values are permitted '
                        '(no function calls, attribute access or imports).'
                        % (rec.formula, type(node).__name__)
                    )
